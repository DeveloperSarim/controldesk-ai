use enigo::{Enigo, Settings, Mouse, Keyboard, Coordinate, Button, Direction, Key};
use xcap::Monitor;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::{DynamicImage, ImageEncoder, ExtendedColorType};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::sync::OnceLock;

// ---------------------------------------------------------------------------
// Global background worker thread that owns the single Enigo instance.
// Using OnceLock so the thread + channel are initialized exactly once.
// ---------------------------------------------------------------------------

enum InputEvent {
    MouseMove   { x: i32, y: i32 },
    MouseButton { x: i32, y: i32, dir: String, btn: String },
    Key         { k_str: String, dir: String },
}

static INPUT_TX: OnceLock<Mutex<mpsc::Sender<InputEvent>>> = OnceLock::new();

fn start_input_worker() {
    let (tx, rx) = mpsc::channel::<InputEvent>();
    INPUT_TX.set(Mutex::new(tx)).ok();

    thread::spawn(move || {
        let settings = Settings::default();
        let mut enigo = match Enigo::new(&settings) {
            Ok(e) => e,
            Err(err) => {
                eprintln!("[controldesk] Enigo init failed: {:?}", err);
                return;
            }
        };

        while let Ok(ev) = rx.recv() {
            let res = match ev {
                InputEvent::MouseMove { x, y } => {
                    enigo.move_mouse(x, y, Coordinate::Abs)
                }
                InputEvent::MouseButton { x, y, dir, btn } => {
                    let _ = enigo.move_mouse(x, y, Coordinate::Abs);
                    let direction = match dir.as_str() {
                        "mousedown" => Direction::Press,
                        "mouseup"   => Direction::Release,
                        _           => Direction::Click,
                    };
                    let button = match btn.as_str() {
                        "right"  => Button::Right,
                        "middle" => Button::Middle,
                        _        => Button::Left,
                    };
                    enigo.button(button, direction)
                }
                InputEvent::Key { k_str, dir } => {
                    let direction = match dir.as_str() {
                        "keydown" => Direction::Press,
                        "keyup"   => Direction::Release,
                        _         => Direction::Click,
                    };
                    let key = match k_str.as_str() {
                        "Backspace"  => Key::Backspace,
                        "Tab"        => Key::Tab,
                        "Enter"      => Key::Return,
                        "Shift"      => Key::Shift,
                        "Control"    => Key::Control,
                        "Alt"        => Key::Alt,
                        "Escape"     => Key::Escape,
                        "Space" | " "=> Key::Space,
                        "Delete"     => Key::Delete,
                        "Home"       => Key::Home,
                        "End"        => Key::End,
                        "PageUp"     => Key::PageUp,
                        "PageDown"   => Key::PageDown,
                        "ArrowLeft"  => Key::LeftArrow,
                        "ArrowUp"    => Key::UpArrow,
                        "ArrowRight" => Key::RightArrow,
                        "ArrowDown"  => Key::DownArrow,
                        "F1"  => Key::F1,  "F2"  => Key::F2,
                        "F3"  => Key::F3,  "F4"  => Key::F4,
                        "F5"  => Key::F5,  "F6"  => Key::F6,
                        "F7"  => Key::F7,  "F8"  => Key::F8,
                        "F9"  => Key::F9,  "F10" => Key::F10,
                        "F11" => Key::F11, "F12" => Key::F12,
                        s if s.chars().count() == 1 => {
                            Key::Unicode(s.chars().next().unwrap())
                        }
                        _ => { continue; }
                    };
                    enigo.key(key, direction)
                }
            };
            if let Err(e) = res {
                eprintln!("[controldesk] Enigo error: {:?}", e);
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Helper: get physical monitor dimensions
// ---------------------------------------------------------------------------
fn monitor_phys_size() -> (u32, u32, f64) {
    // Use xcap to get monitor dimensions — completely avoids Tauri window dependency
    if let Ok(monitors) = Monitor::all() {
        if let Some(m) = monitors.first() {
            let w = m.width().unwrap_or(1920);
            let h = m.height().unwrap_or(1080);
            // xcap returns physical pixels; scale_factor not needed here
            return (w, h, 1.0);
        }
    }
    (1920, 1080, 1.0)
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn handle_remote_input(
    event_type: String,
    x_pct: Option<f64>,
    y_pct: Option<f64>,
    button: Option<String>,
    key: Option<String>,
) -> Result<(), String> {
    let tx_lock = INPUT_TX.get().ok_or("Input worker not started")?;
    let tx = tx_lock.lock().map_err(|e| e.to_string())?;

    let (phys_w, phys_h, _scale) = monitor_phys_size();

    match event_type.as_str() {
        "mousemove" => {
            if let (Some(x), Some(y)) = (x_pct, y_pct) {
                // macOS: Enigo uses logical pixels (divide by scale)
                // Windows/Linux: Enigo uses physical pixels
                #[cfg(target_os = "macos")]
                let (ax, ay) = {
                    // On macOS the monitor dims from xcap are logical already
                    ((x * phys_w as f64) as i32, (y * phys_h as f64) as i32)
                };
                #[cfg(not(target_os = "macos"))]
                let (ax, ay) = (
                    (x * phys_w as f64) as i32,
                    (y * phys_h as f64) as i32,
                );
                tx.send(InputEvent::MouseMove { x: ax, y: ay })
                    .map_err(|e| e.to_string())?;
            }
        }
        "mousedown" | "mouseup" | "click" => {
            if let (Some(x), Some(y)) = (x_pct, y_pct) {
                #[cfg(target_os = "macos")]
                let (ax, ay) = (
                    (x * phys_w as f64) as i32,
                    (y * phys_h as f64) as i32,
                );
                #[cfg(not(target_os = "macos"))]
                let (ax, ay) = (
                    (x * phys_w as f64) as i32,
                    (y * phys_h as f64) as i32,
                );
                tx.send(InputEvent::MouseButton {
                    x: ax,
                    y: ay,
                    dir: event_type,
                    btn: button.unwrap_or_else(|| "left".to_string()),
                })
                .map_err(|e| e.to_string())?;
            }
        }
        "keydown" | "keyup" | "keypress" => {
            if let Some(k) = key {
                tx.send(InputEvent::Key {
                    k_str: k,
                    dir: event_type,
                })
                .map_err(|e| e.to_string())?;
            }
        }
        _ => {}
    }

    Ok(())
}

#[tauri::command]
fn capture_screen() -> Result<String, String> {
    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    if monitors.is_empty() {
        return Err("No monitors found".to_string());
    }
    let monitor = &monitors[0];
    let image_buffer = monitor.capture_image().map_err(|e| e.to_string())?;

    let dynamic_image = DynamicImage::ImageRgba8(image_buffer);

    // Downscale 4K/HiDPI to 1920-wide for bandwidth performance
    let scaled_image = if dynamic_image.width() > 1920 {
        dynamic_image.resize(1920, 1080, image::imageops::FilterType::Nearest)
    } else {
        dynamic_image
    };

    let rgb_image = scaled_image.to_rgb8();
    let mut jpeg_buffer = Vec::new();

    // 80% JPEG quality — crisp HD text, 50% smaller payload than 90%
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buffer, 80);
    encoder
        .write_image(
            rgb_image.as_raw(),
            rgb_image.width(),
            rgb_image.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|e| e.to_string())?;

    Ok(BASE64.encode(jpeg_buffer))
}

// ---------------------------------------------------------------------------
// App entry-point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Start the global input worker before Tauri initializes
    start_input_worker();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, handle_remote_input, capture_screen])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
