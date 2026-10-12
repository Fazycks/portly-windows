import React from "react";
import ReactDOM from "react-dom/client";
import "./styles/tokens.css";
import App from "./App";
import { setApiPort } from "./lib/api";
import { native } from "./lib/native";

// Every window is its own JS context: each asks the app for the port the
// daemon is actually bound to before its first request.
void native.apiPort().then(setApiPort, () => {}).finally(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
