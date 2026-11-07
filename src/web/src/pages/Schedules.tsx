export function Schedules() {
  return (
    <>
      <div className="page-head">
        <h1>Schedules</h1>
      </div>
      <section className="card" aria-labelledby="sched-title" data-testid="schedules">
        <h2 id="sched-title" className="card-title">
          Continuous monitoring: coming soon
        </h2>
        <p>
          Re-run an assessment on a schedule and get an email when something new turns up. Not
          available yet.
        </p>
        <form onSubmit={(e) => e.preventDefault()} className="stack">
          <div className="field">
            <label htmlFor="cadence">Cadence</label>
            <select id="cadence" disabled defaultValue="weekly">
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="notify">Notify me about</label>
            <select id="notify" disabled defaultValue="new">
              <option value="new">New findings</option>
              <option value="any">Any change</option>
            </select>
          </div>
          <button type="submit" className="btn" disabled>
            Create schedule
          </button>
        </form>
      </section>
    </>
  );
}
