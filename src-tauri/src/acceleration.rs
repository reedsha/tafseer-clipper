//! Optional GPU acceleration pack provisioning.
//!
//! The app always ships CPU-only and always degrades to CPU transcription /
//! encoding. Users who want GPU acceleration can download an optional
//! "acceleration pack" (the CUDA runtime libraries) with one click; this
//! module owns that download, the SHA-256 verification, the atomic install and
//! the `TAFSEER_CUDA_DIR` environment variable handed to the sidecar.
//!
//! Contract with the renderer:
//! - command `acceleration_status() -> AccelerationStatus`
//! - command `download_acceleration_pack(manifest_url) -> AccelerationStatus`
//!   (the renderer passes `manifestUrl`; Tauri converts argument names to
//!   camelCase by default)
//! - event `acceleration-progress` carrying [`AccelerationProgress`]
//!
//! Marker: `%LOCALAPPDATA%\Tafseer Clipper\accel\current.json`.
//! Installed pack: `%LOCALAPPDATA%\Tafseer Clipper\accel\<version>\`.

use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

/// Event name the renderer listens to for pack download progress.
pub const ACCELERATION_PROGRESS_EVENT: &str = "acceleration-progress";

/// Marker file inside the acceleration root.
const MARKER_FILE: &str = "current.json";

/// Directory (under `%LOCALAPPDATA%\Tafseer Clipper`) that holds the packs.
const ACCEL_DIR_NAME: &str = "accel";

/// Emit progress at most roughly this often (about 10 events per second).
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Guards against two simultaneous downloads clobbering the same temp dir.
static DOWNLOAD_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

/// Status returned by both commands. Field names are the renderer contract.
#[derive(Debug, Clone, Serialize)]
pub struct AccelerationStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub dir: Option<String>,
    pub size_bytes: u64,
}

impl AccelerationStatus {
    fn not_installed() -> Self {
        Self {
            installed: false,
            version: None,
            dir: None,
            size_bytes: 0,
        }
    }
}

/// Payload of the `acceleration-progress` event. Field names are the renderer
/// contract; `file_index` is zero-based and `phase` is one of `download`,
/// `verify` or `installed`.
#[derive(Debug, Clone, Serialize)]
pub struct AccelerationProgress {
    pub phase: &'static str,
    pub file: Option<String>,
    pub file_index: usize,
    pub file_count: usize,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

/// Manifest published by the update server (relative file URLs are resolved
/// against the manifest URL).
#[derive(Debug, Clone, Deserialize)]
struct AccelerationManifest {
    version: String,
    #[serde(default)]
    total_size: u64,
    #[serde(default)]
    files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Deserialize)]
struct ManifestFile {
    name: String,
    url: String,
    sha256: String,
    #[serde(default)]
    size: u64,
}

/// `current.json` on disk. Written only after every file verified and the
/// temporary directory was renamed into place.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct AccelerationMarker {
    version: String,
    dir: String,
    total_size: u64,
    installed_at: String,
    files: Vec<MarkerFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MarkerFile {
    name: String,
    sha256: String,
    size: u64,
}

/// `%LOCALAPPDATA%\Tafseer Clipper\accel`.
pub(crate) fn accel_root(app: &AppHandle) -> PathBuf {
    crate::local_app_data_dir(app)
        .join("Tafseer Clipper")
        .join(ACCEL_DIR_NAME)
}

/// Absolute path of the installed pack, when the marker exists and its
/// directory is still on disk. `None` means "CPU fallback" — never an error.
pub fn installed_cuda_dir(app: &AppHandle) -> Option<PathBuf> {
    let marker = read_marker(&accel_root(app))?;
    let dir = PathBuf::from(marker.dir);
    dir.is_dir().then_some(dir)
}

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

/// Read the installed GPU acceleration pack status.
#[tauri::command]
pub fn acceleration_status(app: AppHandle) -> AccelerationStatus {
    marker_status(&accel_root(&app))
}

/// Download, verify and install a GPU acceleration pack.
///
/// Resolves with the installed status, or rejects with a readable error. The
/// download streams to disk on the async runtime, so the UI stays responsive;
/// progress is emitted on [`ACCELERATION_PROGRESS_EVENT`].
#[tauri::command]
pub async fn download_acceleration_pack(
    app: AppHandle,
    manifest_url: String,
) -> Result<AccelerationStatus, String> {
    if DOWNLOAD_IN_PROGRESS.swap(true, Ordering::SeqCst) {
        return Err("A GPU acceleration pack download is already in progress.".to_string());
    }
    let _reset = InProgressGuard;

    let root = accel_root(&app);
    let mut emitter = ProgressEmitter::default();
    download_pack(&root, &manifest_url, |progress| {
        emitter.emit(&app, &progress);
    })
    .await
}

struct InProgressGuard;

impl Drop for InProgressGuard {
    fn drop(&mut self) {
        DOWNLOAD_IN_PROGRESS.store(false, Ordering::SeqCst);
    }
}

/// Forwards progress to the renderer, throttled to ~10 events/second while
/// downloading; phase changes are always delivered.
#[derive(Default)]
struct ProgressEmitter {
    last: Option<Instant>,
}

impl ProgressEmitter {
    fn emit(&mut self, app: &AppHandle, progress: &AccelerationProgress) {
        let now = Instant::now();
        let important = matches!(progress.phase, "verify" | "installed");
        let due = self
            .last
            .is_none_or(|last| now.duration_since(last) >= PROGRESS_INTERVAL);
        if !important && !due {
            return;
        }
        self.last = Some(now);
        let _ = app.emit(ACCELERATION_PROGRESS_EVENT, progress.clone());
    }
}

/* -------------------------------------------------------------------------- */
/* Download + install                                                         */
/* -------------------------------------------------------------------------- */

async fn download_pack<F>(
    root: &Path,
    manifest_url: &str,
    mut on_progress: F,
) -> Result<AccelerationStatus, String>
where
    F: FnMut(AccelerationProgress) + Send,
{
    ensure_crypto_provider();

    let manifest_url = Url::parse(manifest_url)
        .map_err(|error| format!("Invalid GPU acceleration manifest URL: {error}"))?;
    ensure_allowed_url(&manifest_url)?;

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Could not create the HTTP client: {error}"))?;

    let manifest = fetch_manifest(&client, &manifest_url).await?;
    validate_manifest(&manifest)?;

    let summed_size: u64 = manifest.files.iter().map(|file| file.size).sum();
    let total_bytes = if summed_size > 0 {
        summed_size
    } else {
        manifest.total_size
    };
    let file_count = manifest.files.len();

    std::fs::create_dir_all(root)
        .map_err(|error| format!("Could not create {}: {error}", root.display()))?;

    let tmp_dir = root.join(format!("{}.tmp", manifest.version));
    let final_dir = root.join(&manifest.version);
    if tmp_dir.exists() {
        std::fs::remove_dir_all(&tmp_dir).map_err(|error| {
            format!(
                "Could not clear the previous partial download at {}: {error}",
                tmp_dir.display()
            )
        })?;
    }
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|error| format!("Could not create {}: {error}", tmp_dir.display()))?;

    if let Err(error) = download_files(
        &client,
        &manifest_url,
        &manifest,
        &tmp_dir,
        total_bytes,
        &mut on_progress,
    )
    .await
    {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(error);
    }

    // Swap the verified pack into place. Windows cannot rename over an existing
    // directory, so drop the previous copy of this version first.
    if final_dir.exists() {
        if let Err(error) = std::fs::remove_dir_all(&final_dir) {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err(format!(
                "Could not replace the previous GPU acceleration pack at {}: {error}",
                final_dir.display()
            ));
        }
    }
    if let Err(error) = std::fs::rename(&tmp_dir, &final_dir) {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(format!(
            "Could not move the GPU acceleration pack into place: {error}"
        ));
    }

    let marker = AccelerationMarker {
        version: manifest.version.clone(),
        dir: final_dir.to_string_lossy().into_owned(),
        total_size: if manifest.total_size > 0 {
            manifest.total_size
        } else {
            total_bytes
        },
        installed_at: iso8601_now(),
        files: manifest
            .files
            .iter()
            .map(|file| MarkerFile {
                name: file.name.clone(),
                sha256: file.sha256.to_ascii_lowercase(),
                size: file.size,
            })
            .collect(),
    };
    if let Err(error) = write_marker(root, &marker) {
        // Do not leave a pack that the status command cannot see.
        let _ = std::fs::remove_dir_all(&final_dir);
        return Err(error);
    }

    on_progress(AccelerationProgress {
        phase: "installed",
        file: None,
        file_index: file_count.saturating_sub(1),
        file_count,
        downloaded_bytes: total_bytes,
        total_bytes,
    });

    Ok(marker_status(root))
}

async fn fetch_manifest(
    client: &Client,
    manifest_url: &Url,
) -> Result<AccelerationManifest, String> {
    let response = client
        .get(manifest_url.clone())
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|error| {
            format!("Could not reach the GPU acceleration manifest at {manifest_url}: {error}")
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "The GPU acceleration manifest request failed with HTTP {}.",
            response.status()
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read the GPU acceleration manifest: {error}"))?;
    serde_json::from_str(&body)
        .map_err(|error| format!("The GPU acceleration manifest is not valid JSON: {error}"))
}

async fn download_files<F>(
    client: &Client,
    manifest_url: &Url,
    manifest: &AccelerationManifest,
    tmp_dir: &Path,
    total_bytes: u64,
    on_progress: &mut F,
) -> Result<(), String>
where
    F: FnMut(AccelerationProgress),
{
    let file_count = manifest.files.len();
    let mut downloaded_bytes: u64 = 0;

    for (index, file) in manifest.files.iter().enumerate() {
        let relative = safe_relative_path(&file.name)?;
        let destination = tmp_dir.join(relative);
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
        }

        let url = resolve_file_url(manifest_url, &file.url)?;
        let mut response = client.get(url.clone()).send().await.map_err(|error| {
            format!("Could not download {} from {url}: {error}", file.name)
        })?;
        if !response.status().is_success() {
            return Err(format!(
                "Downloading {} failed with HTTP {}.",
                file.name,
                response.status()
            ));
        }

        let mut hasher = Sha256::new();
        let mut sink = tokio::io::BufWriter::new(
            tokio::fs::File::create(&destination)
                .await
                .map_err(|error| {
                    format!("Could not create {}: {error}", destination.display())
                })?,
        );
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("Downloading {} was interrupted: {error}", file.name))?
        {
            hasher.update(&chunk);
            sink.write_all(&chunk).await.map_err(|error| {
                format!("Could not write {}: {error}", destination.display())
            })?;
            downloaded_bytes = downloaded_bytes.saturating_add(chunk.len() as u64);
            on_progress(AccelerationProgress {
                phase: "download",
                file: Some(file.name.clone()),
                file_index: index,
                file_count,
                downloaded_bytes,
                total_bytes,
            });
        }
        sink.flush()
            .await
            .map_err(|error| format!("Could not finish writing {}: {error}", destination.display()))?;
        drop(sink);

        on_progress(AccelerationProgress {
            phase: "verify",
            file: Some(file.name.clone()),
            file_index: index,
            file_count,
            downloaded_bytes,
            total_bytes,
        });

        let digest = hasher.finalize();
        let actual = hex(&digest[..]);
        if !actual.eq_ignore_ascii_case(&file.sha256) {
            return Err(format!(
                "Checksum mismatch for {}: expected {}, got {}.",
                file.name, file.sha256, actual
            ));
        }
    }

    Ok(())
}

/* -------------------------------------------------------------------------- */
/* Marker                                                                     */
/* -------------------------------------------------------------------------- */

fn read_marker(root: &Path) -> Option<AccelerationMarker> {
    let raw = std::fs::read_to_string(root.join(MARKER_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn marker_status(root: &Path) -> AccelerationStatus {
    let Some(marker) = read_marker(root) else {
        return AccelerationStatus::not_installed();
    };
    let dir = PathBuf::from(&marker.dir);
    if !dir.is_dir() {
        return AccelerationStatus::not_installed();
    }
    let size_bytes = if marker.total_size > 0 {
        marker.total_size
    } else {
        marker.files.iter().map(|file| file.size).sum()
    };
    AccelerationStatus {
        installed: true,
        version: Some(marker.version),
        dir: Some(marker.dir),
        size_bytes,
    }
}

fn write_marker(root: &Path, marker: &AccelerationMarker) -> Result<(), String> {
    std::fs::create_dir_all(root)
        .map_err(|error| format!("Could not create {}: {error}", root.display()))?;
    let json = serde_json::to_vec_pretty(marker)
        .map_err(|error| format!("Could not serialize the acceleration marker: {error}"))?;
    let target = root.join(MARKER_FILE);
    let temporary = root.join(format!("{MARKER_FILE}.tmp"));
    std::fs::write(&temporary, json)
        .map_err(|error| format!("Could not write {}: {error}", temporary.display()))?;
    if target.exists() {
        std::fs::remove_file(&target)
            .map_err(|error| format!("Could not replace {}: {error}", target.display()))?;
    }
    std::fs::rename(&temporary, &target)
        .map_err(|error| format!("Could not finalize {}: {error}", target.display()))
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

fn validate_manifest(manifest: &AccelerationManifest) -> Result<(), String> {
    validate_version(&manifest.version)?;
    if manifest.files.is_empty() {
        return Err("The GPU acceleration manifest lists no files.".to_string());
    }
    for file in &manifest.files {
        safe_relative_path(&file.name)?;
        if file.sha256.len() != 64 || !file.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!(
                "The GPU acceleration manifest has an invalid SHA-256 checksum for '{}'.",
                file.name
            ));
        }
    }
    Ok(())
}

/// The version becomes a directory name, so reject anything that could escape
/// the acceleration root or collide with Windows path syntax.
fn validate_version(version: &str) -> Result<(), String> {
    if version.is_empty() || version.len() > 64 {
        return Err("The GPU acceleration manifest has an invalid version string.".to_string());
    }
    if version == "." || version == ".." || version.contains("..") {
        return Err(format!(
            "The GPU acceleration manifest version '{version}' is not a valid directory name."
        ));
    }
    let invalid = |character: char| {
        character.is_control()
            || matches!(
                character,
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
            )
    };
    if version.chars().any(invalid) {
        return Err(format!(
            "The GPU acceleration manifest version '{version}' contains characters that are not allowed in a directory name."
        ));
    }
    Ok(())
}

/// Manifest file names are joined onto the temp directory: only plain relative
/// components are allowed (`bin/foo.dll` is fine, `../foo.dll` is not).
fn safe_relative_path(name: &str) -> Result<PathBuf, String> {
    if name.trim().is_empty() {
        return Err("The GPU acceleration manifest contains a file with an empty name.".to_string());
    }
    let path = Path::new(name);
    if path.is_absolute() {
        return Err(format!(
            "The GPU acceleration manifest file '{name}' must be a relative path."
        ));
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            _ => {
                return Err(format!(
                    "The GPU acceleration manifest file '{name}' must not contain '.' or '..' path segments."
                ))
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(format!(
            "The GPU acceleration manifest file '{name}' is not a valid path."
        ));
    }
    Ok(clean)
}

/// HTTPS everywhere; plain HTTP only for loopback hosts (local test servers).
fn ensure_allowed_url(url: &Url) -> Result<(), String> {
    match url.scheme() {
        "https" => Ok(()),
        "http" => {
            let host = url.host_str().unwrap_or_default();
            let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]");
            if loopback {
                Ok(())
            } else {
                Err(format!(
                    "Refusing to download over plain HTTP from {host}; the GPU acceleration pack must be served over HTTPS."
                ))
            }
        }
        scheme => Err(format!(
            "Unsupported URL scheme '{scheme}' in the GPU acceleration manifest; use HTTPS."
        )),
    }
}

fn resolve_file_url(manifest_url: &Url, raw: &str) -> Result<Url, String> {
    let url = manifest_url.join(raw).map_err(|error| {
        format!("Invalid file URL '{raw}' in the GPU acceleration manifest: {error}")
    })?;
    ensure_allowed_url(&url)?;
    Ok(url)
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/// Install the ring crypto provider once. `reqwest` is built with
/// `rustls-no-provider`, so a provider must be registered process-wide before
/// the first HTTPS client is created. The updater plugin may have installed one
/// already, in which case the install simply fails and is ignored.
fn ensure_crypto_provider() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    INSTALLED.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push_str(&format!("{byte:02x}"));
    }
    output
}

#[cfg(test)]
fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex(&hasher.finalize()[..])
}

fn iso8601_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    iso8601_from_unix(seconds)
}

fn iso8601_from_unix(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60
    )
}

/// Howard Hinnant's civil-from-days algorithm (days since 1970-01-01).
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let shifted = days_since_epoch + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/* -------------------------------------------------------------------------- */
/* Tests (no GPU required)                                                    */
/* -------------------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpListener};
    use std::sync::Arc;

    /// Throwaway directory under the process temp dir, removed on drop.
    struct TempRoot {
        path: PathBuf,
    }

    impl TempRoot {
        fn new(label: &str) -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!(
                "tafseer-accel-test-{label}-{}-{unique}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create test root");
            Self { path }
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// Minimal single-threaded HTTP/1.1 server for download tests.
    struct TestServer {
        address: SocketAddr,
        stop: Arc<AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl TestServer {
        fn start(routes: Vec<(&str, Vec<u8>)>) -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test server");
            listener
                .set_nonblocking(true)
                .expect("non-blocking test server");
            let address = listener.local_addr().expect("test server address");
            let stop = Arc::new(AtomicBool::new(false));
            let stop_flag = Arc::clone(&stop);
            let routes: Vec<(String, Vec<u8>)> = routes
                .into_iter()
                .map(|(path, body)| (path.to_string(), body))
                .collect();
            let thread = std::thread::spawn(move || {
                while !stop_flag.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            // On Windows an accepted socket INHERITS the listener's
                            // non-blocking mode (unlike Linux). Without this the
                            // read/write below can return WouldBlock, the client
                            // sees a truncated response and reqwest reports
                            // "error sending request" - the intermittent CI
                            // failure this test used to produce.
                            let _ = stream.set_nonblocking(false);
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                            let mut buffer = [0u8; 4096];
                            let read = stream.read(&mut buffer).unwrap_or(0);
                            let request = String::from_utf8_lossy(&buffer[..read]);
                            let path = request
                                .lines()
                                .next()
                                .and_then(|line| line.split_whitespace().nth(1))
                                .unwrap_or("/");
                            let body = routes
                                .iter()
                                .find(|(route, _)| route == path)
                                .map(|(_, body)| body.clone());
                            let response = match body {
                                Some(body) => {
                                    let mut response = format!(
                                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                                        body.len()
                                    )
                                    .into_bytes();
                                    response.extend_from_slice(&body);
                                    response
                                }
                                None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                    .to_vec(),
                            };
                            let _ = stream.write_all(&response);
                            let _ = stream.flush();
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        // A transient accept error (for example WSAECONNRESET on
                        // Windows when a client connects and immediately closes)
                        // must NOT terminate the server: breaking here killed the
                        // listener for the rest of the test, so every later
                        // request failed with "error sending request".
                        Err(_) => std::thread::sleep(Duration::from_millis(5)),
                    }
                }
            });
            Self {
                address,
                stop,
                thread: Some(thread),
            }
        }

        fn url(&self, path: &str) -> String {
            format!("http://{}{}", self.address, path)
        }
    }

    impl Drop for TestServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    #[test]
    fn sha256_hex_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn manifest_parses_and_resolves_relative_urls() {
        let manifest: AccelerationManifest = serde_json::from_str(
            r#"{
                "version": "2026.11",
                "total_size": 42,
                "files": [
                    {
                        "name": "bin/cudart64_12.dll",
                        "url": "files/cudart64_12.dll",
                        "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
                        "size": 42
                    }
                ]
            }"#,
        )
        .expect("parse manifest");
        assert_eq!(manifest.version, "2026.11");
        assert_eq!(manifest.total_size, 42);
        assert_eq!(manifest.files.len(), 1);
        validate_manifest(&manifest).expect("manifest is valid");

        let base = Url::parse("https://updates.example.com/accel/manifest.json").expect("base url");
        let resolved = resolve_file_url(&base, &manifest.files[0].url).expect("resolve");
        assert_eq!(
            resolved.as_str(),
            "https://updates.example.com/accel/files/cudart64_12.dll"
        );
        let absolute = resolve_file_url(&base, "https://cdn.example.com/cudart.dll").expect("resolve");
        assert_eq!(absolute.as_str(), "https://cdn.example.com/cudart.dll");
    }

    #[test]
    fn unsafe_manifest_paths_and_versions_are_rejected() {
        assert!(safe_relative_path("../evil.dll").is_err());
        assert!(safe_relative_path("bin/../../evil.dll").is_err());
        assert!(safe_relative_path("C:\\Windows\\evil.dll").is_err());
        assert!(safe_relative_path("/etc/passwd").is_err());
        assert!(safe_relative_path("").is_err());
        assert!(safe_relative_path("bin/cudart64_12.dll").is_ok());
        assert!(validate_version("../1.0").is_err());
        assert!(validate_version("1.0/2").is_err());
        assert!(validate_version("").is_err());
        assert!(validate_version("2026.11").is_ok());
    }

    #[test]
    fn http_is_only_allowed_for_loopback() {
        assert!(
            ensure_allowed_url(&Url::parse("https://updates.example.com/manifest.json").unwrap())
                .is_ok()
        );
        assert!(ensure_allowed_url(&Url::parse("http://127.0.0.1:8080/manifest.json").unwrap()).is_ok());
        assert!(ensure_allowed_url(&Url::parse("http://localhost:8080/manifest.json").unwrap()).is_ok());
        assert!(ensure_allowed_url(&Url::parse("http://example.com/manifest.json").unwrap()).is_err());
        assert!(ensure_allowed_url(&Url::parse("ftp://example.com/manifest.json").unwrap()).is_err());
    }

    #[test]
    fn iso8601_timestamps_are_formatted() {
        assert_eq!(iso8601_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_from_unix(1_700_000_000), "2023-11-14T22:13:20Z");
    }

    /// Locks the JSON field names the renderer codes against.
    #[test]
    fn status_and_progress_json_contract() {
        let status = AccelerationStatus {
            installed: true,
            version: Some("2026.11".to_string()),
            dir: Some("C:\\pack".to_string()),
            size_bytes: 42,
        };
        let json = serde_json::to_value(&status).expect("serialize status");
        assert_eq!(json["installed"], true);
        assert_eq!(json["version"], "2026.11");
        assert_eq!(json["dir"], "C:\\pack");
        assert_eq!(json["size_bytes"], 42);
        assert!(json.get("sizeBytes").is_none());

        let missing = serde_json::to_value(AccelerationStatus::not_installed()).expect("serialize");
        assert_eq!(missing["installed"], false);
        assert_eq!(missing["version"], serde_json::Value::Null);
        assert_eq!(missing["dir"], serde_json::Value::Null);
        assert_eq!(missing["size_bytes"], 0);

        let progress = AccelerationProgress {
            phase: "download",
            file: Some("cudart64_12.dll".to_string()),
            file_index: 0,
            file_count: 2,
            downloaded_bytes: 10,
            total_bytes: 100,
        };
        let json = serde_json::to_value(&progress).expect("serialize progress");
        assert_eq!(json["phase"], "download");
        assert_eq!(json["file"], "cudart64_12.dll");
        assert_eq!(json["file_index"], 0);
        assert_eq!(json["file_count"], 2);
        assert_eq!(json["downloaded_bytes"], 10);
        assert_eq!(json["total_bytes"], 100);
        assert!(json.get("fileIndex").is_none());
    }

    #[test]
    fn marker_round_trip() {
        let root = TempRoot::new("marker");
        let pack_dir = root.path.join("2026.11");
        std::fs::create_dir_all(&pack_dir).expect("create pack dir");
        let marker = AccelerationMarker {
            version: "2026.11".to_string(),
            dir: pack_dir.to_string_lossy().into_owned(),
            total_size: 1_234,
            installed_at: "2026-11-14T00:00:00Z".to_string(),
            files: vec![MarkerFile {
                name: "cudart64_12.dll".to_string(),
                sha256: "ab".repeat(32),
                size: 1_234,
            }],
        };
        write_marker(&root.path, &marker).expect("write marker");
        assert!(root.path.join(MARKER_FILE).exists());

        let status = marker_status(&root.path);
        assert!(status.installed);
        assert_eq!(status.version.as_deref(), Some("2026.11"));
        assert_eq!(status.dir.as_deref(), Some(marker.dir.as_str()));
        assert_eq!(status.size_bytes, 1_234);

        let reread = read_marker(&root.path).expect("read marker");
        assert_eq!(reread.installed_at, "2026-11-14T00:00:00Z");
        assert_eq!(reread.files.len(), 1);
    }

    #[test]
    fn marker_with_missing_directory_is_not_installed() {
        let root = TempRoot::new("marker-missing");
        let marker = AccelerationMarker {
            version: "1.0.0".to_string(),
            dir: root.path.join("gone").to_string_lossy().into_owned(),
            total_size: 10,
            installed_at: "2026-11-14T00:00:00Z".to_string(),
            files: Vec::new(),
        };
        write_marker(&root.path, &marker).expect("write marker");
        let status = marker_status(&root.path);
        assert!(!status.installed);
        assert!(status.version.is_none());
        assert!(status.dir.is_none());
        assert_eq!(status.size_bytes, 0);
    }

    #[tokio::test]
    async fn downloads_pack_and_writes_marker() {
        let payload = b"cuda-runtime-library-bytes".to_vec();
        let checksum = sha256_hex(&payload);
        let manifest = format!(
            r#"{{"version":"2026.11","total_size":{size},"files":[{{"name":"cudart64_12.dll","url":"files/cudart64_12.dll","sha256":"{checksum}","size":{size}}}]}}"#,
            size = payload.len(),
        );
        let server = TestServer::start(vec![
            ("/manifest.json", manifest.into_bytes()),
            ("/files/cudart64_12.dll", payload.clone()),
        ]);
        let root = TempRoot::new("download-ok");
        let manifest_url = server.url("/manifest.json");
        let mut progress = Vec::new();

        let status = download_pack(&root.path, &manifest_url, |event| progress.push(event))
            .await
            .expect("download pack");

        assert!(status.installed);
        assert_eq!(status.version.as_deref(), Some("2026.11"));
        assert_eq!(status.size_bytes, payload.len() as u64);
        let dir = PathBuf::from(status.dir.expect("installed dir"));
        assert_eq!(
            std::fs::read(dir.join("cudart64_12.dll")).expect("read installed file"),
            payload
        );
        assert!(root.path.join(MARKER_FILE).exists());
        assert!(!root.path.join("2026.11.tmp").exists());
        assert!(progress.iter().any(|event| event.phase == "download"));
        assert!(progress.iter().any(|event| event.phase == "verify"));
        assert!(progress.iter().any(|event| event.phase == "installed"));
    }

    #[tokio::test]
    async fn corrupted_checksum_fails_and_cleans_up() {
        let payload = b"this payload does not match the manifest checksum".to_vec();
        let manifest = format!(
            r#"{{"version":"2026.11","total_size":{size},"files":[{{"name":"cudart64_12.dll","url":"file.bin","sha256":"{checksum}","size":{size}}}]}}"#,
            size = payload.len(),
            checksum = "0".repeat(64),
        );
        let server = TestServer::start(vec![
            ("/manifest.json", manifest.into_bytes()),
            ("/file.bin", payload),
        ]);
        let root = TempRoot::new("download-bad-sha");
        let manifest_url = server.url("/manifest.json");

        let error = download_pack(&root.path, &manifest_url, |_| {})
            .await
            .expect_err("checksum mismatch must fail");
        assert!(
            error.to_lowercase().contains("checksum"),
            "unexpected error: {error}"
        );
        assert!(
            !root.path.join("2026.11.tmp").exists(),
            "temporary directory must be removed"
        );
        assert!(
            !root.path.join("2026.11").exists(),
            "failed pack must not be installed"
        );
        assert!(
            !root.path.join(MARKER_FILE).exists(),
            "marker must not be written on failure"
        );
    }

    #[tokio::test]
    async fn unreachable_manifest_returns_readable_error() {
        // Bind and immediately drop a listener to get a port nobody listens on.
        let port = TcpListener::bind(("127.0.0.1", 0))
            .expect("bind")
            .local_addr()
            .expect("address")
            .port();
        let root = TempRoot::new("download-offline");
        let error = download_pack(
            &root.path,
            &format!("http://127.0.0.1:{port}/manifest.json"),
            |_| {},
        )
        .await
        .expect_err("offline download must fail");
        assert!(
            error.contains("Could not reach the GPU acceleration manifest"),
            "unexpected error: {error}"
        );
        assert!(!root.path.join("current.json").exists());
    }
}
