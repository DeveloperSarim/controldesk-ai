use enigo::{Enigo, Settings, Mouse, Keyboard, Coordinate, Button, Direction, Key};
use tauri::{Window, Runtime};
use xcap::Monitor;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use image::{DynamicImage, ImageEncoder, ExtendedColorType};
use std::sync::{mpsc, Mutex};
use std::thread;

// Enum representing the inputs we will simulate on the single background worker thread
enum InputEvent {
    MouseMove {
        x: f64,
        y: f64,
        size: tauri::PhysicalSize<u32>,
        scale: f64,
    },
    MouseButton {
        event_type: String,
        button: Option<String>,
        x_pct: Option<f64>,
        y_pct: Option<f64>,
        size: tauri::PhysicalSize<u32>,
        scale: f64,
    },
    Keyboard {
        event_type: String,
        key: Option<String>,
    },
}

// Thread-safe wrapper around the mpsc::Sender to store in Tauri state
struct InputSender(Mutex<mpsc::Sender<InputEvent>>);

// Helper function to safely retrieve monitor dimensions and scale factor with fallbacks
fn get_monitor_info<R: Runtime>(window: &Window<R>) -> (tauri::PhysicalSize<u32>, f64) {
    if let Ok(Some(monitor)) = window.primary_monitor() {
        return (monitor.size().clone(), monitor.scale_factor());
    }
    if let Ok(monitors) = window.available_monitors() {
        if let Some(monitor) = monitors.first() {
            return (monitor.size().clone(), monitor.scale_factor());
        }
    }
    // Safe fallback: Full HD at 1.0 scale factor
    (tauri::PhysicalSize { width: 1920, height: 1080 }, 1.0)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn handle_remote_input<R: Runtime>(
    window: Window<R>,
    sender_state: tauri::State<'_, InputSender>,
    event_type: String,
    x_pct: Option<f64>,
    y_pct: Option<f64>,
    button: Option<String>,
    key: Option<String>,
) -> Result<(), String> {
    let (size, scale) = get_monitor_info(&window);
    let tx = sender_state.0.lock().map_err(|e| e.to_string())?;

    match event_type.as_str() {
        "mousemove" => {
            if let (Some(x), Some(y)) = (x_pct, y_pct) {
                tx.send(InputEvent::MouseMove { x, y, size, scale })
                    .map_err(|e| e.to_string())?;
            }
        }
        "mousedown" | "mouseup" | "click" => {
            tx.send(InputEvent::MouseButton {
                event_type,
                button,
                x_pct,
                y_pct,
                size,
                scale,
            })
            .map_err(|e| e.to_string())?;
        }
        "keydown" | "keyup" | "keypress" => {
            tx.send(InputEvent::Keyboard { event_type, key })
                .map_err(|e| e.to_string())?;
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
    
    // Performance optimization: downscale 4K / High-DPI screens to 1920px width
    let scaled_image = if dynamic_image.width() > 1920 {
        dynamic_image.resize(1920, 1080, image::imageops::FilterType::Nearest)
    } else {
        dynamic_image
    };
    
    let rgb_image = scaled_image.to_rgb8();
    let mut jpeg_buffer = Vec::new();
    
    // Create a JpegEncoder with 80% quality for balanced HD clarity and optimal FPS performance
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buffer, 80);
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
    let (tx, rx) = mpsc::channel::<InputEvent>();

    // Spawn single background worker thread to host the Enigo instance
    thread::spawn(move || {
        let settings = Settings::default();
        let mut enigo = match Enigo::new(&settings) {
            Ok(e) => e,
            Err(err) => {
                eprintln!("Failed to initialize Enigo worker thread: {:?}", err);
                return;
            }
        };

        while let Ok(event) = rx.recv() {
            let res = match event {
                InputEvent::MouseMove { x, y, size, scale } => {
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
                }
                InputEvent::MouseButton { event_type, button, x_pct, y_pct, size, scale } => {
                    if let (Some(x), Some(y)) = (x_pct, y_pct) {
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
                        if let Err(e) = enigo.move_mouse(abs_x, abs_y, Coordinate::Abs) {
                            eprintln!("Button move failed: {:?}", e);
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
                    } else {
                        Ok(())
                    }
                }
                InputEvent::Keyboard { event_type, key } => {
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
                            _ => continue,
                        };
                        enigo.key(k, dir)
                    } else {
                        Ok(())
                    }
                }
            };
            if let Err(e) = res {
                eprintln!("Enigo worker execution failed: {:?}", e);
            }
        }
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(InputSender(Mutex::new(tx)))
        .invoke_handler(tauri::generate_handler![greet, handle_remote_input, capture_screen])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
