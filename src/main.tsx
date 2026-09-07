import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LocaleProvider } from "./i18n";
import { MotionProvider } from "./lib/Motion";
import { ScaleProvider } from "./lib/Scale";
import { FfmpegProvider } from "./lib/Ffmpeg";
import { QueueProvider } from "./lib/Queue";
import { SpeedProvider } from "./lib/Speed";
import { SelectionProvider } from "./lib/Selection";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <LocaleProvider>
      <MotionProvider>
        <ScaleProvider>
          <FfmpegProvider>
            <SpeedProvider>
              <QueueProvider>
                <SelectionProvider>
                  <App />
                </SelectionProvider>
              </QueueProvider>
            </SpeedProvider>
          </FfmpegProvider>
        </ScaleProvider>
      </MotionProvider>
    </LocaleProvider>
  </StrictMode>,
);
