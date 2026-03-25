import React from "react";
import ReactDOM from "react-dom/client";

import App from "./app/App";
import WidgetApp from "./app/WidgetApp";
import "./index.css";

const isWidgetMode = new URLSearchParams(window.location.search).get("mode") === "widget";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isWidgetMode ? <WidgetApp /> : <App />}
  </React.StrictMode>
);
