use enigo::{Enigo, Settings, Mouse, Keyboard, Coordinate, Button, Direction, Key};
use tauri::{Window, Runtime};
use xcap::Monitor;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::{DynamicImage, ImageEncoder, ExtendedColorType};

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn handle_remote_input<R: Runtime>(
    window: Window<R>,
    event_type: String,
    x_pct: Option<f64>,
    y_pct: Option<f64>,
    button: Option<String>,
    key: Option<String>,
) -> Result<(), String> {
    let settings = Settings::default();
    let mut enigo = Enigo::new(&settings).map_err(|e| e.to_string())?;

    match event_type.as_str() {
        "mousemove" => {
            if let (Some(x), Some(y)) = (x_pct, y_pct) {
                if let Ok(Some(monitor)) = window.primary_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    #[cfg(target_os = "macos")]
                    let (abs_x, abs_y) = (
                        ((x * size.width as f64) / scale) as i32,
                        ((y * size.height as f64) / scale) as i32,
                    );
                    #[cfg(not(target_os = "macos"))]
                    let (abs_x, abs_y) = (
                        (x * size.width as f64) as i32,
                        (y * size.height as f64) as i32,
                    );
                    enigo.move_mouse(abs_x, abs_y, Coordinate::Abs)
                        .map_err(|e| format!("Move mouse failed: {:?}", e))?;
                }
            }
        }
        "mousedown" | "mouseup" | "click" => {
            if let (Some(x), Some(y)) = (x_pct, y_pct) {
                if let Ok(Some(monitor)) = window.primary_monitor() {
                    let size = monitor.size();
                    let scale = monitor.scale_factor();
                    #[cfg(target_os = "macos")]
                    let (abs_x, abs_y) = (
                        ((x * size.width as f64) / scale) as i32,
                        ((y * size.height as f64) / scale) as i32,
                    );
                    #[cfg(not(target_os = "macos"))]
                    let (abs_x, abs_y) = (
                        (x * size.width as f64) as i32,
                        (y * size.height as f64) as i32,
                    );
                    enigo.move_mouse(abs_x, abs_y, Coordinate::Abs)
                        .map_err(|e| format!("Move mouse failed: {:?}", e))?;
                }
            }
            let dir = match event_type.as_str() {
                "mousedown" => Direction::Press,
                "mouseup" => Direction::Release,
                _ => Direction::Click,
            };
            if let Some(btn_str) = button {
                let btn = match btn_str.as_str() {
                    "right" => Button::Right,
                    "middle" => Button::Middle,
                    _ => Button::Left,
                };
                enigo.button(btn, dir)
                    .map_err(|e| format!("Button failed: {:?}", e))?;
            }
        }
        "keydown" | "keyup" | "keypress" => {
            let dir = match event_type.as_str() {
                "keydown" => Direction::Press,
                "keyup" => Direction::Release,
                _ => Direction::Click,
            };
            if let Some(k_str) = key {
                let k = match k_str.as_str() {
                    "Backspace" => Key::Backspace,
                    "Tab" => Key::Tab,
                    "Enter" => Key::Return,
                    "Shift" => Key::Shift,
                    "Control" => Key::Control,
                    "Alt" => Key::Alt,
                    "Escape" => Key::Escape,
                    "Space" | " " => Key::Space,
                    "ArrowLeft" => Key::LeftArrow,
                    "ArrowUp" => Key::UpArrow,
                    "ArrowRight" => Key::RightArrow,
                    "ArrowDown" => Key::DownArrow,
                    s if s.chars().count() == 1 => {
                        let c = s.chars().next().unwrap();
                        Key::Unicode(c)
                    }
                    _ => return Ok(()),
                };
                enigo.key(k, dir)
                    .map_err(|e| format!("Key failed: {:?}", e))?;
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
    let rgb_image = dynamic_image.to_rgb8();
    let mut jpeg_buffer = Vec::new();
    
    // Create a JpegEncoder with 90% quality for high-definition screen sharing
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buffer, 90);
    encoder
        .write_image(
            rgb_image.as_raw(),
            rgb_image.width(),
            rgb_image.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(|e| e.to_string())?;
        
    let base64_str = BASE64.encode(jpeg_buffer);
    Ok(base64_str)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, handle_remote_input, capture_screen])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
