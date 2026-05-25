# ControlDesk Ai - Development Notes & Configuration Tracker

ControlDesk Ai is a premium, cross-platform AnyDesk clone designed for remote desktop control and screen sharing, utilizing a Supabase signaling channel and a custom WebRTC peer-to-peer connection.

---

## 🚀 Key Features

1. **Native Screen Capture (Tauri Host)**:
   - Uses the Rust `xcap` crate to capture desktop frames at **30 FPS**.
   - Compresses frames to **90% JPEG quality** for high-definition text legibility and minimal compression artifacts.
   - Streams frames to WebRTC using an HTML5 Canvas wrapper `canvas.captureStream(30)` in `src/App.tsx`.

2. **Native OS Input Control (Tauri Host)**:
   - Uses the Rust `enigo` crate to execute mouse movement, clicks, and keyboard strokes.
   - **Retina/DPI Scaling**: Automatically divides physical screen coordinates by the display's `scale_factor()` in Rust (`src-tauri/src/lib.rs`). This ensures mouse clicks land pixel-perfect on macOS Retina and high-DPI Windows/Linux displays.

3. **Browser DOM Input Simulator (Browser/Mobile Host)**:
   - Dispatches simulated `mousedown`, `mouseup`, and keyboard events to sandboxed browsers using coordinates relative to `window.innerWidth`/`window.innerHeight` and targeting elements with `document.elementFromPoint`.

4. **Zero Screen Blockage UI**:
   - The connection header and scale toolbar sit **directly above** the screenshare container (not floating as an absolute overlay). This prevents any UI elements from blocking browser tabs, address bars, or window close buttons on the shared desktop.

5. **Apple-style Zoom & Sizing Picker**:
   - Glassmorphic segmented controller (`Fit`, `50%`, `75%`, `100%`, `125%`, `150%`) with scrollable wrapper panning support.

---

## 🛠️ Build & Development Commands

- **Run in Development (Vite + Tauri)**:
  ```bash
  npm run tauri dev
  ```
- **Build Frontend**:
  ```bash
  npm run build
  ```
- **Build Production App**:
  ```bash
  npm run tauri build
  ```
  *Note: Compiles and builds the production `.app` bundle on macOS under `src-tauri/target/release/bundle/macos/controldesk-ai.app`.*

---

## ⚠️ Platform Warnings & Permissions

### macOS Native Permissions
Because this app simulates OS-level actions, macOS requires explicit security authorizations. If these are disabled, control actions will be silently ignored:
1. **Screen Recording**: Settings > Privacy & Security > Screen Recording > Toggle `controldesk-ai` ON.
2. **Accessibility**: Settings > Privacy & Security > Accessibility > Click `+` and add `controldesk-ai.app`, then toggle ON.

### Cross-Platform `.exe` Build Generation
To build the Windows `.exe` installer, you must run the build command on a Windows machine:
```bash
npm run tauri build
```
Alternatively, set up a GitHub Action CI pipeline (`.github/workflows/build.yml`) utilizing `windows-latest` runners to generate both Mac `.dmg` and Windows `.exe` binaries automatically on every push.
