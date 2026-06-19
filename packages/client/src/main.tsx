import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

if (window.location.hash === "#/demo/audio-input") {
  const { AudioInputDemo } = await import("./demo/AudioInputDemo");
  createRoot(rootEl).render(<AudioInputDemo />);
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
