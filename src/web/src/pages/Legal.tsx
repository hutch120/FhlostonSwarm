import type { LegalDocument } from "../../content/legal.js";

/** Renders a terms or privacy document from `content/legal.ts`. */
export function Legal({ doc, testId }: { doc: LegalDocument; testId: string }) {
  return (
    <article className="card narrow legal" data-testid={testId} aria-labelledby={`${testId}-title`}>
      <h1 id={`${testId}-title`}>{doc.title}</h1>
      <p className="muted">{doc.summary}</p>
      {doc.sections.map((section) => (
        <section key={section.heading}>
          <h2 className="card-title">{section.heading}</h2>
          {section.paragraphs.map((text) => (
            <p key={text}>{text}</p>
          ))}
        </section>
      ))}
    </article>
  );
}
