import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("le point de montage #root est absent de la page");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
