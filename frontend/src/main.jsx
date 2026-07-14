import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

console.log(
  "%cYou found the console.\n%cThe rest of this portfolio is exactly this fragmented — you just can't see the seams yet.\n\n— Kaara",
  "color:#e5342a;font-family:monospace;font-size:13px;font-weight:bold;",
  "color:#8a8a98;font-family:monospace;font-size:11px;"
);

createRoot(document.getElementById("root")).render(<App />);
