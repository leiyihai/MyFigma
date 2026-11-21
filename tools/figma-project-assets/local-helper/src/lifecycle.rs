use crate::App;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};
use tiny_http::Server;

/// 退出请求。托盘菜单和测试钩子共用同一入口，避免出现两条退出路径。
#[derive(Clone, Default)]
pub struct Shutdown {
    requested: Arc<AtomicBool>,
}

impl Shutdown {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn request(&self) {
        self.requested.store(true, Ordering::SeqCst);
    }

    pub fn is_requested(&self) -> bool {
        self.requested.load(Ordering::SeqCst)
    }

    /// 阻塞到进程被要求退出；无托盘时也有明确的等待点。
    pub fn wait(&self) {
        while !self.is_requested() {
            thread::sleep(Duration::from_millis(50));
        }
    }
}

/// 在后台线程服务 HTTP，直到收到退出请求；返回时监听套接字已释放。
pub fn serve(server: Server, mut app: App, port: u16, shutdown: &Shutdown) {
    while !shutdown.is_requested() {
        match server.recv_timeout(Duration::from_millis(200)) {
            Ok(Some(request)) => crate::serve(request, &mut app, port),
            Ok(None) => {}
            Err(_) => break,
        }
    }
}
