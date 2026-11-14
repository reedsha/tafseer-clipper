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
    // Kept in sync with tauri-build's default `windows-app-manifest.xml`.
    let mut resource = tauri_winres::WindowsResource::new();
    resource.set_manifest(
        r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
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
</assembly>"#,
    );
    resource
        .compile_for_everything()
        .expect("failed to embed the Windows application manifest");
}
