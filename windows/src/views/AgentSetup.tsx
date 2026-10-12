// Port of AgentSetup.swift (AgentOnboardingCard + SetupStep). The file work the
// Swift AgentSetup class does (skill copy, CLI install, managed rule blocks in
// ~/.agents/AGENTS.md and ~/.claude/CLAUDE.md) runs in the daemon behind
// GET/POST /agent-setup.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { api, type AgentSetupStatus } from "../lib/api";
import { Symbol } from "../lib/symbols";
import { Button, T } from "../components/ui";
import "./AgentSetup.css";

function useAgentSetup() {
  const [status, setStatus] = useState<AgentSetupStatus | null>(null);
  const [isWorking, setIsWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api.agentSetupStatus().then(setStatus).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  const install = async () => {
    setIsWorking(true);
    setErrorMessage(null);
    try {
      setStatus(await api.agentSetupInstall());
    } catch (e) {
      setErrorMessage((e as Error).message);
    } finally {
      setIsWorking(false);
      refresh();
    }
  };

  const skillInstalled = status?.skillInstalled ?? false;
  const rulesInstalled = (status?.agentsRulesInstalled ?? false) && (status?.claudeRulesInstalled ?? false);
  return { skillInstalled, rulesInstalled, isWorking, errorMessage, install };
}

export function AgentOnboardingCard({ onDismiss }: { onDismiss: () => void }) {
  const setup = useAgentSetup();
  const setupComplete = setup.skillInstalled && setup.rulesInstalled;
  const tint = setupComplete ? "var(--sys-green)" : "var(--accent)";

  return (
    <div className="agent-card-wrap">
      <div className="agent-card" role="group" aria-label="Portly agent setup">
        <div className="agent-card-head">
          <span className="agent-card-badge" style={{ color: tint, background: `color-mix(in srgb, ${tint} 12%, transparent)` }}>
            {setupComplete
              ? <Symbol name="checkmark.seal.fill" size={18} strokeWidth={2.4} />
              : <Sparkles size={19} strokeWidth={2.4} aria-hidden />}
          </span>
          <div className="agent-card-text">
            <span style={T.project}>{setupComplete ? "You’re good to go" : "Let’s set up Portly for your agents"}</span>
            <span style={T.body} className="secondary">
              {setupComplete
                ? "Work as you always do. Your agents now know to use Portly automatically."
                : "Two quick steps give your coding agents the Portly skill and global server rules."}
            </span>
          </div>
          <span className="agent-card-spacer" />
          {setupComplete
            ? <Button variant="prominent" onClick={onDismiss}>Done</Button>
            : <Button variant="borderless" className="agent-card-notnow" onClick={onDismiss}>Not now</Button>}
        </div>

        {!setupComplete && (
          <div className="agent-card-steps">
            <SetupStep
              number={1}
              title={setup.skillInstalled ? "Skill installed" : "Set up the Portly skill"}
              detail="Installs the skill and bundled CLI for your coding agents."
              isComplete={setup.skillInstalled}
            >
              <Button disabled={setup.skillInstalled || setup.isWorking} onClick={setup.install}>
                {setup.skillInstalled ? "Installed" : "Install Skill"}
              </Button>
            </SetupStep>
            <SetupStep
              number={2}
              title={setup.rulesInstalled ? "Global rules installed" : "Set up global agent rules"}
              detail="Updates AGENTS.md and CLAUDE.md without replacing your existing rules."
              isComplete={setup.rulesInstalled}
            >
              <Button variant="prominent" disabled={!setup.skillInstalled || setup.rulesInstalled || setup.isWorking} onClick={setup.install}>
                {setup.rulesInstalled ? "Installed" : "Install Rules"}
              </Button>
            </SetupStep>
          </div>
        )}

        {setup.errorMessage && (
          <div className="agent-card-error">
            <Symbol name="exclamationmark.triangle.fill" size={10} />
            <span>{setup.errorMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function SetupStep({ number, title, detail, isComplete, children }: {
  number: number; title: string; detail: string; isComplete: boolean; children: ReactNode;
}) {
  return (
    <div className="setup-step">
      {isComplete ? (
        <span className="setup-step-icon" style={{ color: "var(--sys-green)" }}><Symbol name="checkmark.circle.fill" size={17} strokeWidth={2.4} /></span>
      ) : (
        // "\(number).circle.fill": a filled accent disc with the number knocked out.
        <span className="setup-step-icon"><span className="setup-step-number">{number}</span></span>
      )}
      <div className="setup-step-text">
        <span style={T.bodyMedium}>{title}</span>
        <span className="setup-step-detail">{detail}</span>
      </div>
      <span className="setup-step-spacer" />
      {children}
    </div>
  );
}
