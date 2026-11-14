//! Build script: Tauri code generation plus the Windows application manifest.
//!
//! The Common Controls v6 manifest is embedded into **every** linkable target,
//! not just the binaries. `tauri-build` links its manifest into binaries only,
//! so the library unit-test binary would otherwise load `comctl32.dll` v5 and
//! die at startup with `STATUS_ENTRYPOINT_NOT_FOUND` (the GUI stack imports
//! `TaskDialogIndirect` and the subclassing helpers, which only exist in v6).
//! `cargo test` must work on this machine, so the manifest is embedded globally
//! here and `tauri-build` is told to leave the manifest to us.

fn main() {
    #[cfg(windows)]
    {
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attributes).expect("failed to run tauri-build");
        embed_windows_manifest();
    }

    #[cfg(not(windows))]
    tauri_build::build();
}

#[cfg(windows)]
fn embed_windows_manifest() {
    // Why this does not use `tauri_winres`:
    //
    // `tauri-build` always compiles a Windows resource on Windows and links it
    // into the binaries with `cargo:rustc-link-arg-bins`. The `tauri_winres`
    // helper always writes that resource script to `OUT_DIR/resource.rc` and
    // compiles it to `OUT_DIR/resource.lib`, and its `compile_for_everything()`
    // links the SAME library into EVERY target with `cargo:rustc-link-arg`.
    //
    // The binaries therefore end up linking `resource.lib` twice, and a
    // resource library linked twice is duplicated inside the binary. MSVC
    // rejects that outright:
    //
    //     CVTRES : fatal error CVT1100: duplicate resource. type:VERSION, name:1
    //     LINK   : fatal error LNK1123: failure during conversion to COFF
    //
    // The GNU toolchain tolerates the duplicate, so the problem was invisible
    // locally and only appeared on CI (and would have broken every MSVC
    // release build).
    //
    // The fix is to compile a SECOND, separate resource that contains only the
    // manifest - no `VERSIONINFO` block - under a different file name, so it
    // becomes a different library:
    //
    //   binaries : resource.lib (tauri-build: VERSIONINFO)
    //            + tafseer_manifest.lib (this file: the manifest)
    //   tests    : tafseer_manifest.lib (the manifest - the whole point)
    //
    // Each target links each resource exactly once, and the resource ids do
    // not collide (VERSION is type 16, the manifest is type 24).
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is not set");
    let rc_path = std::path::Path::new(&out_dir).join("tafseer_manifest.rc");
    std::fs::write(&rc_path, manifest_rc()).expect("failed to write the manifest resource script");

    embed_resource::compile_for_everything(&rc_path, embed_resource::NONE)
        .manifest_required()
        .expect("the compiled resource must contain a manifest");
}

/// The resource script: the Common Controls v6 manifest and nothing else.
/// Deliberately no `VERSIONINFO` block - tauri-build already provides one.
#[cfg(windows)]
fn manifest_rc() -> String {
    let mut rc = String::from("#pragma code_page(65001)\n1 24\n{\n");
    for line in MANIFEST.lines() {
        rc.push_str("\" ");
        rc.push_str(&escape_rc(line.trim()));
        rc.push_str(" \"\n");
    }
    rc.push_str("}\n");
    rc
}

/// Kept in sync with tauri-build's default `windows-app-manifest.xml`.
#[cfg(windows)]
const MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>"#;

/// Escape a string for a quoted Windows resource-script string.
/// Double quotes are doubled (the RC way); the rest is escaped C-style.
#[cfg(windows)]
fn escape_rc(s: &str) -> String {
    let mut escaped = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '"' => escaped.push_str("\"\""),
            '\'' => escaped.push_str("\\'"),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\t' => escaped.push_str("\\t"),
            '\r' => escaped.push_str("\\r"),
            _ => escaped.push(ch),
        }
    }
    escaped
}
