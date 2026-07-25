import { useEffect, useState } from 'react';

import { playStartupSound } from '../audio/sounds';
import { PixelIcon } from './PixelIcon';

interface StartupScreenProps {
  automation: boolean;
  onComplete: () => void;
}

export function StartupScreen({ automation, onComplete }: StartupScreenProps) {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    playStartupSound();
    const timings = automation ? [30, 80, 150] : [520, 1_250, 2_350];
    const timers = [
      setTimeout(() => setStage(1), timings[0]),
      setTimeout(() => setStage(2), timings[1]),
      setTimeout(onComplete, timings[2]),
    ];
    return () => timers.forEach(clearTimeout);
  }, [automation, onComplete]);

  return (
    <div className={`startup-screen startup-stage-${stage}`} role="status" aria-live="polite">
      <div className="startup-monitor">
        {stage > 0 && (
          <>
            <PixelIcon name="computer" size={64} />
            <div className="startup-title">The Macintosh</div>
            <div className="startup-subtitle">Starting up…</div>
            {stage > 1 && (
              <div className="startup-progress" aria-label="Startup progress">
                <div className="startup-progress-fill" />
              </div>
            )}
          </>
        )}
      </div>
      <div className="startup-scanline" />
    </div>
  );
}
