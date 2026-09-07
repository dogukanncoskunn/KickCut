import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LocaleProvider } from "./i18n";
import { MotionProvider } from "./lib/Motion";
import { ScaleProvider } from "./lib/Scale";
import { SelectionProvider } from "./lib/Selection";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <MotionProvider>
        <ScaleProvider>
          <SelectionProvider>
            <App />
          </SelectionProvider>
        </ScaleProvider>
      </MotionProvider>
    </LocaleProvider>
  </StrictMode>,
);
