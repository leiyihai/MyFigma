//! Windows 托盘入口：只负责展示运行状态、打开数据目录和请求退出。
//!
//! 托盘窗口、菜单和消息循环都在这里，`main` 只做启动与等待接入。

use crate::lifecycle::Shutdown;
use std::path::Path;

pub struct Tray<'a> {
    pub port: u16,
    pub data_dir: &'a Path,
    pub token: &'a str,
    pub shutdown: Shutdown,
    /// 仅测试使用：把与托盘「退出」菜单相同的命令延迟发给托盘窗口。
    pub test_exit_after_ms: Option<u64>,
}

#[cfg(windows)]
pub fn run(tray: Tray<'_>) -> Result<(), &'static str> {
    imp::run(tray)
}

#[cfg(not(windows))]
pub fn run(_tray: Tray<'_>) -> Result<(), &'static str> {
    Err("当前平台没有 Windows 通知区域")
}

#[cfg(windows)]
mod imp {
    use super::Tray;
    use crate::lifecycle::Shutdown;
    use std::{
        path::PathBuf,
        ptr::{null, null_mut},
        sync::OnceLock,
    };
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            Shell::{
                NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
                Shell_NotifyIconW, ShellExecuteW,
            },
            WindowsAndMessaging::{
                AppendMenuW, CreatePopupMenu, CreateWindowExW, DefWindowProcW, DestroyMenu,
                DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW, IDC_ARROW,
                IDI_APPLICATION, KillTimer, LoadCursorW, LoadIconW, MF_GRAYED, MF_SEPARATOR,
                MF_STRING, MSG, PostMessageW, PostQuitMessage, RegisterClassW, SW_SHOWNORMAL,
                SetForegroundWindow, SetTimer, TPM_BOTTOMALIGN, TPM_LEFTALIGN, TPM_RIGHTBUTTON,
                TrackPopupMenu, TranslateMessage, WM_APP, WM_CLOSE, WM_COMMAND, WM_CONTEXTMENU,
                WM_DESTROY, WM_LBUTTONUP, WM_NULL, WM_RBUTTONUP, WM_TIMER, WNDCLASSW,
                WS_OVERLAPPED,
            },
        },
    };

    const CALLBACK_MESSAGE: u32 = WM_APP + 1;
    const TEST_TIMER: usize = 1;
    const MENU_STATUS: usize = 1;
    const MENU_OPEN_DIRECTORY: usize = 2;
    const MENU_SHOW_TOKEN: usize = 3;
    const MENU_EXIT: usize = 4;
    const ICON_ID: u32 = 1;

    struct Runtime {
        shutdown: Shutdown,
        data_dir: PathBuf,
        token: String,
        port: u16,
    }

    // 托盘窗口和菜单回调只有一条消息线程，运行期配置在创建窗口前写入一次。
    static RUNTIME: OnceLock<Runtime> = OnceLock::new();

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn fill_tip(destination: &mut [u16; 128], text: &str) {
        let units: Vec<u16> = text.encode_utf16().take(127).collect();
        destination[..units.len()].copy_from_slice(&units);
    }

    fn status_text() -> String {
        match RUNTIME.get() {
            Some(runtime) => format!("资源助手运行中 · 端口 {}", runtime.port),
            None => "资源助手运行中".to_owned(),
        }
    }

    unsafe fn icon_data(hwnd: HWND) -> NOTIFYICONDATAW {
        let mut data = NOTIFYICONDATAW {
            cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
            hWnd: hwnd,
            uID: ICON_ID,
            uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
            uCallbackMessage: CALLBACK_MESSAGE,
            hIcon: unsafe { LoadIconW(null_mut(), IDI_APPLICATION) },
            ..Default::default()
        };
        fill_tip(&mut data.szTip, &status_text());
        data
    }

    unsafe fn request_exit(hwnd: HWND) {
        if let Some(runtime) = RUNTIME.get() {
            runtime.shutdown.request();
        }
        unsafe {
            DestroyWindow(hwnd);
        }
    }

    unsafe fn open_data_directory() {
        let Some(runtime) = RUNTIME.get() else {
            return;
        };
        let operation = wide("open");
        let directory = wide(&runtime.data_dir.to_string_lossy());
        unsafe {
            ShellExecuteW(
                null_mut(),
                operation.as_ptr(),
                directory.as_ptr(),
                null(),
                null(),
                SW_SHOWNORMAL,
            );
        }
    }

    unsafe fn show_token() {
        if let Some(runtime) = RUNTIME.get() {
            // 只在用户显式请求时输出；正常启动日志不包含令牌。
            println!("PAIRING TOKEN: {}", runtime.token);
        }
    }

    unsafe fn show_menu(hwnd: HWND) {
        unsafe {
            let menu = CreatePopupMenu();
            if menu.is_null() {
                return;
            }
            let status = wide(&status_text());
            AppendMenuW(menu, MF_STRING | MF_GRAYED, MENU_STATUS, status.as_ptr());
            AppendMenuW(menu, MF_SEPARATOR, 0, null());
            let directory = wide("打开数据目录");
            AppendMenuW(menu, MF_STRING, MENU_OPEN_DIRECTORY, directory.as_ptr());
            let token = wide("显示配对令牌");
            AppendMenuW(menu, MF_STRING, MENU_SHOW_TOKEN, token.as_ptr());
            AppendMenuW(menu, MF_SEPARATOR, 0, null());
            let exit = wide("退出");
            AppendMenuW(menu, MF_STRING, MENU_EXIT, exit.as_ptr());
            let mut point = POINT { x: 0, y: 0 };
            GetCursorPos(&mut point);
            SetForegroundWindow(hwnd);
            TrackPopupMenu(
                menu,
                TPM_RIGHTBUTTON | TPM_LEFTALIGN | TPM_BOTTOMALIGN,
                point.x,
                point.y,
                0,
                hwnd,
                null(),
            );
            PostMessageW(hwnd, WM_NULL, 0, 0);
            DestroyMenu(menu);
        }
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        unsafe {
            match message {
                CALLBACK_MESSAGE => {
                    let event = lparam as u32;
                    if matches!(event, WM_RBUTTONUP | WM_LBUTTONUP | WM_CONTEXTMENU) {
                        show_menu(hwnd);
                    }
                    0
                }
                WM_COMMAND => {
                    match wparam & 0xffff {
                        MENU_EXIT => request_exit(hwnd),
                        MENU_OPEN_DIRECTORY => open_data_directory(),
                        MENU_SHOW_TOKEN => show_token(),
                        _ => {}
                    }
                    0
                }
                WM_TIMER if wparam == TEST_TIMER => {
                    // 测试钩子只投递菜单命令，退出仍走托盘「退出」看的同一条路径。
                    KillTimer(hwnd, TEST_TIMER);
                    PostMessageW(hwnd, WM_COMMAND, MENU_EXIT, 0);
                    0
                }
                WM_CLOSE => {
                    request_exit(hwnd);
                    0
                }
                WM_DESTROY => {
                    let mut data = icon_data(hwnd);
                    data.uFlags = 0;
                    data.hIcon = null_mut();
                    Shell_NotifyIconW(NIM_DELETE, &data);
                    PostQuitMessage(0);
                    0
                }
                _ => DefWindowProcW(hwnd, message, wparam, lparam),
            }
        }
    }

    pub(super) fn run(tray: Tray<'_>) -> Result<(), &'static str> {
        let _ = RUNTIME.set(Runtime {
            shutdown: tray.shutdown,
            data_dir: tray.data_dir.to_path_buf(),
            token: tray.token.to_owned(),
            port: tray.port,
        });
        unsafe {
            let instance = GetModuleHandleW(null());
            if instance.is_null() {
                return Err("无法获取程序模块");
            }
            let class_name = wide("MyFigmaAssetsHelperTray");
            let window_class = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: LoadIconW(null_mut(), IDI_APPLICATION),
                hCursor: LoadCursorW(null_mut(), IDC_ARROW),
                hbrBackground: null_mut(),
                lpszMenuName: null(),
                lpszClassName: class_name.as_ptr(),
            };
            if RegisterClassW(&window_class) == 0 {
                return Err("无法注册托盘窗口");
            }
            let title = wide("MyFigma 资源助手");
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                title.as_ptr(),
                WS_OVERLAPPED,
                0,
                0,
                0,
                0,
                null_mut(),
                null_mut(),
                instance,
                null_mut(),
            );
            if hwnd.is_null() {
                return Err("无法创建托盘窗口");
            }
            if Shell_NotifyIconW(NIM_ADD, &icon_data(hwnd)) == 0 {
                DestroyWindow(hwnd);
                return Err("系统未接受托盘图标");
            }
            println!("TRAY ready");
            if let Some(delay) = tray.test_exit_after_ms {
                SetTimer(
                    hwnd,
                    TEST_TIMER,
                    u32::try_from(delay).unwrap_or(u32::MAX),
                    None,
                );
            }
            let mut message = MSG::default();
            while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        Ok(())
    }
}
