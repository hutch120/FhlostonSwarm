import { AREAS, DEMO_TARGET, tierRoster, tiers, type TierId } from "@swarm/shared";
import { useEffect } from "react";
import { Link } from "react-router";
import { Counters } from "../panels/Counters.js";
import { usePlayerStore, useReplay } from "../replay/useReplay.js";
import { useSession } from "../state/session.js";
import { useRunStore } from "../state/run.js";
import { SwarmCanvas } from "../swarm/SwarmCanvas.js";

const ROSTER = tierRoster("siege");
const TIER_ORDER: TierId[] = ["scout", "sweep", "probe", "siege"];
const REPLAY_SPEED = 3;
const LOOP_PAUSE_MS = 4000;

const STEPS = [
  {
    title: "Tell us what to test",
    body: "Give the address of your application and, if you want the signed-in side covered, a test login. A scan only ever touches the hosts you declare.",
  },
  {
    title: "The swarm goes to work",
    body: "A team of specialised AI agents probes your application in parallel, one area each, and you can watch every step as it happens.",
  },
  {
    title: "Get a verified report",
    body: "Each finding is checked again by an independent agent before it reaches you, with plain-language fixes. Anything we could not test is listed too, never hidden.",
  },
];

const SAFEGUARDS = [
  {
    title: "Read-only",
    body: "Scans look, they do not change anything: no deleting, no purchases, no form submissions beyond signing in.",
  },
  {
    title: "Scoped",
    body: "Every request goes through a guard that allows only the hosts and ports you declared and refuses anything else.",
  },
  {
    title: "Your logins stay private",
    body: "Credentials are typed in by our code and never shown to the AI. Use staging accounts and rotate them afterwards.",
  },
  {
    title: "Honest about limits",
    body: "Every report says what was covered and what was not, so you always know what the assessment did and did not look at.",
  },
];

/** The demo replay on a loop: a short pause at the end, then the swarm sets off again. */
function useLoopingDemo() {
  useReplay({ autoplay: true, speed: REPLAY_SPEED });
  const finished = usePlayerStore((s) => s.finished);
  const player = usePlayerStore((s) => s.player);
  useEffect(() => {
    if (!finished || !player) return;
    const timer = setTimeout(() => player.play(), LOOP_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [finished, player]);
}

export function Landing() {
  const email = useSession((s) => s.email);
  const state = useRunStore((s) => s.state);
  useLoopingDemo();

  return (
    <div className="landing">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">Automated web application security testing</p>
          <h1 id="hero-title">Find the weak spots before an attacker does.</h1>
          <p className="lead">
            Swarm sends a team of AI security agents at your web application. They test it the way
            an attacker would, check each other&rsquo;s work, and hand you a clear report you can
            act on, in minutes rather than weeks.
          </p>
          <div className="cta-row">
            {email ? (
              <Link to="/dashboard" className="btn btn-primary btn-lg">
                Go to your dashboard
              </Link>
            ) : (
              <Link to="/new" className="btn btn-primary btn-lg">
                Start a scan
              </Link>
            )}
            <Link to="/demo" className="btn btn-lg">
              Watch the full demo
            </Link>
          </div>
        </div>
        <div className="hero-art">
          <SwarmCanvas
            target={DEMO_TARGET}
            selected={null}
            onSelect={() => undefined}
            agents={ROSTER.agents}
            areas={ROSTER.areas}
          />
          <p className="muted small">
            A simulated run against a made-up target, <code>{DEMO_TARGET}</code>.
          </p>
          <Counters state={state} />
        </div>
      </section>

      <section className="section" aria-labelledby="how-title">
        <h2 id="how-title">How it works</h2>
        <ol className="steps">
          {STEPS.map((step, i) => (
            <li key={step.title} className="card">
              <span className="step-number" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{step.title}</h3>
              <p className="muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="section" aria-labelledby="covers-title">
        <h2 id="covers-title">What the swarm covers</h2>
        <ul className="grid-cards">
          {AREAS.map((area) => (
            <li key={area.id} className="card" style={{ borderTopColor: area.colour }}>
              <h3>{area.name}</h3>
              <p className="muted">{area.summary}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="section" aria-labelledby="depths-title">
        <h2 id="depths-title">Pick how deep to go</h2>
        <p className="muted">
          Four scan depths, each running every agent of the one before it. Use a light scan often
          and a deep one before a launch.
        </p>
        <ul className="grid-cards">
          {TIER_ORDER.map((id) => (
            <li key={id} className="card">
              <h3>{tiers[id].name}</h3>
              <p className="muted">{tiers[id].description}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="section" aria-labelledby="safe-title">
        <h2 id="safe-title">Safe by design</h2>
        <ul className="grid-cards">
          {SAFEGUARDS.map((item) => (
            <li key={item.title} className="card">
              <h3>{item.title}</h3>
              <p className="muted">{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="cta-band" aria-labelledby="cta-title">
        <h2 id="cta-title">See what the swarm finds in your application.</h2>
        <Link to={email ? "/new" : "/login"} className="btn btn-primary btn-lg">
          {email ? "Start a scan" : "Sign in to get started"}
        </Link>
      </section>
    </div>
  );
}
