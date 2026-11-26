//! OS-backed API key encryption commands (Windows DPAPI).
//!
//! Sealed values carry the `"dpapi:"` prefix followed by standard base64 of the
//! DPAPI opaque blob tied to the current Windows user account. Legacy unprefixed
//! strings pass through `unprotect_secret` unchanged so existing installations
//! migrate smoothly on startup.

const DPAPI_PREFIX: &str = "dpapi:";
const BASE64_TABLE: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        let combined = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_TABLE[(combined >> 18) & 0x3f] as char);
        out.push(BASE64_TABLE[(combined >> 12) & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            BASE64_TABLE[(combined >> 6) & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            BASE64_TABLE[combined & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err("Invalid base64 length".to_string());
    }
    let mut out = Vec::with_capacity((bytes.len() / 4) * 3);
    for (idx, chunk) in bytes.chunks_exact(4).enumerate() {
        let mut vals = [0u8; 4];
        let mut pad = 0usize;
        for (i, &ch) in chunk.iter().enumerate() {
            if ch == b'=' {
                if i < 2 || (i == 2 && chunk[3] != b'=') || (idx + 1) * 4 != bytes.len() {
                    return Err("Invalid base64 padding".to_string());
                }
                pad += 1;
                vals[i] = 0;
            } else {
                vals[i] = match ch {
                    b'A'..=b'Z' => ch - b'A',
                    b'a'..=b'z' => ch - b'a' + 26,
                    b'0'..=b'9' => ch - b'0' + 52,
                    b'+' => 62,
                    b'/' => 63,
                    _ => return Err("Invalid base64 character".to_string()),
                };
            }
        }
        let combined = ((vals[0] as u32) << 18)
            | ((vals[1] as u32) << 12)
            | ((vals[2] as u32) << 6)
            | (vals[3] as u32);
        out.push(((combined >> 16) & 0xff) as u8);
        if pad < 2 {
            out.push(((combined >> 8) & 0xff) as u8);
        }
        if pad < 1 {
            out.push((combined & 0xff) as u8);
        }
    }
    Ok(out)
}

#[cfg(windows)]
fn dpapi_protect(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| "Secret too large for DPAPI".to_string())?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: `input` and `output` are valid stack structs pointing to `bytes`
    // for the duration of `CryptProtectData`.
    let ok = unsafe {
        CryptProtectData(
            &mut input,
            0usize as _,
            0usize as _,
            0usize as _,
            0usize as _,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        // SAFETY: `GetLastError` reads the thread-local Win32 error code.
        let code = unsafe { GetLastError() };
        return Err(format!("DPAPI protect failed (code {code})"));
    }
    if output.pbData.is_null() {
        return Err("DPAPI protect returned a null buffer".to_string());
    }
    // SAFETY: DPAPI allocated `output.pbData` with `cbData` bytes via `LocalAlloc`.
    let protected = unsafe {
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let owned = slice.to_vec();
        LocalFree(output.pbData.cast());
        owned
    };
    Ok(protected)
}

#[cfg(windows)]
fn dpapi_unprotect(cipher: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(cipher.len()).map_err(|_| "Ciphertext too large for DPAPI".to_string())?,
        pbData: cipher.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: `input` and `output` remain valid for the syscall.
    let ok = unsafe {
        CryptUnprotectData(
            &mut input,
            0usize as _,
            0usize as _,
            0usize as _,
            0usize as _,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        // SAFETY: `GetLastError` reads the thread-local Win32 error code.
        let code = unsafe { GetLastError() };
        return Err(format!("DPAPI unprotect failed (code {code})"));
    }
    if output.pbData.is_null() {
        return Err("DPAPI unprotect returned a null buffer".to_string());
    }
    // SAFETY: DPAPI allocated `output.pbData` with `cbData` bytes via `LocalAlloc`.
    let plaintext = unsafe {
        let slice = std::slice::from_raw_parts(output.pbData, output.cbData as usize);
        let owned = slice.to_vec();
        LocalFree(output.pbData.cast());
        owned
    };
    Ok(plaintext)
}

#[tauri::command]
pub fn protect_secret(plaintext: String) -> Result<String, String> {
    if plaintext.is_empty() || plaintext.starts_with(DPAPI_PREFIX) {
        return Ok(plaintext);
    }
    #[cfg(windows)]
    {
        let protected = dpapi_protect(plaintext.as_bytes())?;
        Ok(format!("{DPAPI_PREFIX}{}", base64_encode(&protected)))
    }
    #[cfg(not(windows))]
    {
        Ok(plaintext)
    }
}

#[tauri::command]
pub fn unprotect_secret(ciphertext: String) -> Result<String, String> {
    if ciphertext.is_empty() {
        return Ok(String::new());
    }
    let Some(encoded) = ciphertext.strip_prefix(DPAPI_PREFIX) else {
        return Ok(ciphertext);
    };
    #[cfg(windows)]
    {
        let raw = base64_decode(encoded)?;
        let decrypted = dpapi_unprotect(&raw)?;
        String::from_utf8(decrypted).map_err(|_| "Decrypted secret is not valid UTF-8".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = encoded;
        Err("DPAPI-protected secrets can only be decrypted on Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip_all_remainders() {
        for sample in [
            b"".as_slice(),
            b"a",
            b"ab",
            b"abc",
            b"sk-proj-test-key-12345",
            "ทดสอบ-secret-🔑".as_bytes(),
        ] {
            let encoded = base64_encode(sample);
            let decoded = base64_decode(&encoded).expect("decode valid base64");
            assert_eq!(decoded, sample);
        }
    }

    #[test]
    fn base64_rejects_malformed_inputs() {
        assert!(base64_decode("abc").is_err());
        assert!(base64_decode("a=cd").is_err());
        assert!(base64_decode("ab=d").is_err());
        assert!(base64_decode("ab*d").is_err());
    }

    #[test]
    fn unprotect_passes_through_empty_and_legacy_plaintext() {
        assert_eq!(unprotect_secret(String::new()).unwrap(), "");
        assert_eq!(
            unprotect_secret("sk-legacy-plain".to_string()).unwrap(),
            "sk-legacy-plain"
        );
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip_seals_and_unseals() {
        let secret = "sk-live-test-key-987654321".to_string();
        let sealed = protect_secret(secret.clone()).expect("protect secret");
        assert!(sealed.starts_with(DPAPI_PREFIX));
        assert_ne!(sealed, secret);
        assert_eq!(protect_secret(sealed.clone()).unwrap(), sealed);
        let unsealed = unprotect_secret(sealed).expect("unprotect secret");
        assert_eq!(unsealed, secret);
    }
}
