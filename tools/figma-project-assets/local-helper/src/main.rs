mod atlas;
mod lifecycle;
mod tray;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    thread,
    time::Duration,
};
use tiny_http::{Header, Method, Request, Response, Server};

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Project {
    id: String,
    name: String,
    path: String,
    maintained: bool,
}

struct App {
    data: PathBuf,
    token: String,
    projects: Vec<Project>,
}

pub(crate) fn private_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

impl App {
    fn open(data: PathBuf) -> std::io::Result<Self> {
        fs::create_dir_all(&data)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&data, fs::Permissions::from_mode(0o700))?;
        }
        let token_path = data.join("token");
        if !token_path.exists() {
            let mut bytes = [0u8; 32];
            rand::rng().fill_bytes(&mut bytes);
            let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            private_write(&token_path, token.as_bytes())?;
        }
        let token = fs::read_to_string(token_path)?;
        if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(std::io::Error::other("invalid local credentials"));
        }
        let projects = if data.join("projects.json").exists() {
            serde_json::from_slice(&fs::read(data.join("projects.json"))?)?
        } else {
            Vec::new()
        };
        Ok(Self {
            data,
            token,
            projects,
        })
    }

    fn save(&self, projects: &[Project]) -> Result<()> {
        let temp = self.data.join("projects.tmp");
        // Only one request executes at a time. Recover a leftover interrupted write.
        if temp.exists() {
            fs::remove_file(&temp).map_err(|_| "无法保存登记")?;
        }
        private_write(
            &temp,
            &serde_json::to_vec(projects).map_err(|_| "无法保存登记")?,
        )
        .map_err(|_| "无法保存登记")?;
        fs::rename(temp, self.data.join("projects.json")).map_err(|_| "无法保存登记")
    }

    fn route(&mut self, method: &Method, url: &str, body: &[u8]) -> Result<Value> {
        match (method, url) {
            (&Method::Get, "/v1/health") => Ok(json!({"schemaVersion":1,"status":"ready"})),
            (&Method::Post, "/v1/scan") => {
                let request: Value = serde_json::from_slice(body).map_err(|_| "扫描格式错误")?;
                let id = request["projectId"].as_str().ok_or("缺少项目编号")?;
                let project = self
                    .projects
                    .iter()
                    .find(|p| p.id == id)
                    .ok_or("项目未登记")?;
                atlas::scan(&self.data, project)
            }
            (&Method::Get, "/v1/projects") => {
                Ok(json!({"schemaVersion":1,"projects":self.projects}))
            }
            (&Method::Put, "/v1/projects") => {
                let mut project: Project =
                    serde_json::from_slice(body).map_err(|_| "登记格式错误")?;
                if project.id.is_empty()
                    || project.id.len() > 64
                    || !project
                        .id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                    || project.name.trim().is_empty()
                    || project.name.len() > 200
                {
                    return Err("项目编号或名称无效");
                }
                let path = Path::new(&project.path)
                    .canonicalize()
                    .map_err(|_| "资源目录不可用")?;
                if !path.is_dir() {
                    return Err("资源目录不可用");
                }
                project.path = path.to_string_lossy().into_owned();
                // Keep the user's original spelling; never send it to Figma.
                #[cfg(windows)]
                {
                    project.path = project
                        .path
                        .strip_prefix(r"\\?\")
                        .unwrap_or(&project.path)
                        .to_string();
                }
                let mut projects = self.projects.clone();
                projects.retain(|p| p.id != project.id);
                projects.push(project);
                if projects.len() > 1000 {
                    return Err("登记项目过多");
                }
                self.save(&projects)?;
                self.projects = projects;
                Ok(json!({"schemaVersion":1,"projects":self.projects}))
            }
            (&Method::Delete, path) if path.starts_with("/v1/projects/") => {
                let id = &path[13..];
                let projects: Vec<_> = self
                    .projects
                    .iter()
                    .filter(|p| p.id != id)
                    .cloned()
                    .collect();
                self.save(&projects)?;
                self.projects = projects;
                Ok(json!({"schemaVersion":1,"projects":self.projects}))
            }
            _ => Err("未知操作"),
        }
    }
}

fn header<'a>(request: &'a Request, name: &str) -> Option<&'a str> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}
fn authenticated(request: &Request, token: &str) -> bool {
    let expected = format!("Bearer {token}");
    let given = header(request, "Authorization").unwrap_or("");
    given.len() == expected.len()
        && given
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |a, (b, c)| a | (b ^ c))
            == 0
}
fn serve(mut request: Request, app: &mut App, port: u16) {
    let origin = header(&request, "Origin").map(str::to_owned);
    let allowed_origin = origin
        .as_deref()
        .is_none_or(|s| s == "null" || s == "https://www.figma.com");
    let ip_host = format!("127.0.0.1:{port}");
    let localhost_host = format!("localhost:{port}");
    let host = header(&request, "Host");
    let local = request.remote_addr().is_some_and(|a| a.ip().is_loopback())
        && (host == Some(ip_host.as_str()) || host == Some(localhost_host.as_str()));
    let (status, value) = if !allowed_origin || !local {
        (403, json!({"error":"连接来源被拒绝"}))
    } else if request.method() == &Method::Options {
        (204, json!(null))
    } else if !authenticated(&request, &app.token) {
        (401, json!({"error":"请使用本机配对令牌"}))
    } else {
        let has_body = matches!(request.method(), Method::Put | Method::Post);
        if has_body && header(&request, "Content-Type") != Some("application/json") {
            (415, json!({"error":"需要 application/json"}))
        } else {
            let mut body = Vec::new();
            if request
                .as_reader()
                .take(65537)
                .read_to_end(&mut body)
                .is_err()
                || body.len() > 65536
            {
                (413, json!({"error":"请求过大"}))
            } else {
                match app.route(request.method(), request.url(), &body) {
                    Ok(value) => (200, value),
                    Err(error) => (400, json!({"error":error})),
                }
            }
        }
    };
    let mut response = Response::from_string(if status == 204 {
        String::new()
    } else {
        value.to_string()
    })
    .with_status_code(status);
    for (name, value) in [
        ("Content-Type", "application/json"),
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("Vary", "Origin"),
    ] {
        response.add_header(Header::from_bytes(name, value).unwrap());
    }
    if allowed_origin && local {
        if let Some(origin) = origin {
            response.add_header(Header::from_bytes("Access-Control-Allow-Origin", origin).unwrap());
        }
        response.add_header(
            Header::from_bytes(
                "Access-Control-Allow-Methods",
                "GET, PUT, POST, DELETE, OPTIONS",
            )
            .unwrap(),
        );
        response.add_header(
            Header::from_bytes(
                "Access-Control-Allow-Headers",
                "Authorization, Content-Type",
            )
            .unwrap(),
        );
        response.add_header(
            Header::from_bytes("Access-Control-Allow-Private-Network", "true").unwrap(),
        );
    }
    let _ = request.respond(response);
}
fn run() -> std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|p| p.join("MyFigmaAssets"));
    let mut port = 38473u16;
    let mut show_tray = true;
    let mut test_exit_after_ms = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => data = args.next().map(PathBuf::from),
            "--port" => port = args.next().ok_or("missing port")?.parse()?,
            // 仅测试/CI：跳过托盘，直接等待退出请求。
            "--no-tray" => show_tray = false,
            // 仅测试：延迟触发与托盘「退出」相同的退出路径。
            "--test-exit-after-ms" => {
                test_exit_after_ms = Some(args.next().ok_or("missing exit delay")?.parse()?)
            }
            _ => return Err("unknown argument".into()),
        }
    }
    let data = data.ok_or("LOCALAPPDATA unavailable")?;
    let app = App::open(data.clone())?;
    let server = Server::http((std::net::Ipv4Addr::LOCALHOST, port))?;
    let actual_port = server
        .server_addr()
        .to_ip()
        .ok_or("invalid listener")?
        .port();
    println!("LISTEN {actual_port}");
    let shutdown = lifecycle::Shutdown::new();
    let worker = {
        let shutdown = shutdown.clone();
        thread::spawn(move || lifecycle::serve(server, app, actual_port, &shutdown))
    };
    let tray_result = if show_tray {
        tray::run(tray::Tray {
            port: actual_port,
            data_dir: &data,
            shutdown: shutdown.clone(),
            test_exit_after_ms,
        })
    } else {
        if let Some(delay) = test_exit_after_ms {
            let shutdown = shutdown.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(delay));
                shutdown.request();
            });
        }
        shutdown.wait();
        Ok(())
    };
    if let Err(reason) = tray_result {
        eprintln!("托盘不可用（{reason}），助手继续在后台运行；请关闭启动它的终端窗口停止。");
        shutdown.wait();
    }
    let _ = worker.join();
    println!("STOP");
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("助手启动失败：请检查端口占用、本机应用数据权限和配置格式。");
        std::process::exit(1);
    }
}
