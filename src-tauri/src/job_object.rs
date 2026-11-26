//! Windows Job Object lifecycle wrapper for the spawned Python sidecar.
//!
//! Ensures the sidecar and every child process it spawns (FFmpeg, worker
//! processes) terminate immediately when the desktop shell exits or crashes,
//! without waiting on the sidecar's polling watchdog.

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

#[cfg(windows)]
pub(crate) struct SidecarJobObject {
    handle: HANDLE,
}

#[cfg(windows)]
// SAFETY: A Win32 Job Object handle can be closed from any thread when dropped.
unsafe impl Send for SidecarJobObject {}
#[cfg(windows)]
// SAFETY: Shared references only pass the OS handle to thread-safe Win32 APIs.
unsafe impl Sync for SidecarJobObject {}

#[cfg(windows)]
impl SidecarJobObject {
    pub(crate) fn create() -> Option<Self> {
        // SAFETY: Passing null pointers creates an unnamed private job object.
        let handle = unsafe { CreateJobObjectW(0usize as _, 0usize as _) };
        if handle.is_null() {
            return None;
        }
        // SAFETY: JOBOBJECT_EXTENDED_LIMIT_INFORMATION is plain C POD data.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let len = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        // SAFETY: `info` stays alive and initialized for the duration of the syscall.
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&raw const info).cast(),
                len,
            )
        };
        if ok == 0 {
            // SAFETY: `handle` is non-null and owned here.
            unsafe {
                CloseHandle(handle);
            }
            return None;
        }
        Some(Self { handle })
    }

    pub(crate) fn assign_pid(&self, pid: u32) -> bool {
        if self.handle.is_null() {
            return false;
        }
        // SAFETY: Opening the spawned child PID with minimum required rights.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return false;
        }
        // SAFETY: Both `self.handle` and `process` are valid non-null Win32 handles.
        let ok = unsafe { AssignProcessToJobObject(self.handle, process) };
        // SAFETY: `process` is closed immediately after job assignment.
        unsafe {
            CloseHandle(process);
        }
        ok != 0
    }
}

#[cfg(windows)]
impl Drop for SidecarJobObject {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: Owned job handle; closing triggers KILL_ON_JOB_CLOSE.
            unsafe {
                CloseHandle(self.handle);
            }
            self.handle = std::ptr::null_mut();
        }
    }
}

#[cfg(not(windows))]
pub(crate) struct SidecarJobObject;

#[cfg(not(windows))]
impl SidecarJobObject {
    pub(crate) fn create() -> Option<Self> {
        Some(Self)
    }

    pub(crate) fn assign_pid(&self, _pid: u32) -> bool {
        true
    }
}
