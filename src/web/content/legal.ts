import { TERMS_VERSION } from "@swarm/shared";

/**
 * Terms of use and privacy notice shown in the intake flow and at /terms and /privacy. This is a
 * working draft for the private beta; legal review is scheduled before launch (PLAN.md section 17).
 * Changing the wording means bumping TERMS_VERSION in @swarm/shared so each acknowledgement records
 * which text it was given against.
 */
export { TERMS_VERSION };

export interface LegalSection {
  heading: string;
  paragraphs: string[];
}

export interface LegalDocument {
  title: string;
  summary: string;
  sections: LegalSection[];
}

export const terms: LegalDocument = {
  title: "Terms of use",
  summary: `Version ${TERMS_VERSION}. Swarm tests applications you are authorised to test. Read this before you start a scan.`,
  sections: [
    {
      heading: "Only test what you are authorised to test",
      paragraphs: [
        "By starting a scan you confirm that you own the systems you enter, or that you have the owner's written permission to test them, and that you are allowed to share the test logins you provide.",
        "Swarm sends real requests to the hostnames you enter and signs in with the logins you supply. We do not verify ownership, so the confirmation you give is relied on. We record it with the time, your network address and the version of these terms.",
        "You are responsible for any effect a scan has on your systems and on any third party that shares them. Scans are non-destructive and rate-limited, but they can still cause load, create records or trigger alerts.",
      ],
    },
    {
      heading: "Use staging, never production",
      paragraphs: [
        "Run scans against a staging or test copy of your application. Give Swarm test accounts only, with test data you are comfortable having probed, and rotate those passwords afterwards.",
        "Do not enter production credentials, personal data about real people, or credentials for systems you do not control.",
      ],
    },
    {
      heading: "What you get",
      paragraphs: [
        "Swarm is automated and AI-assisted. A report lists what the agents found and which areas they could not cover. It is not a certification, it is not a guarantee that no other issue exists, and it does not replace a manual penetration test.",
        "The service is provided as is, with no warranty, during a private beta. Findings can be wrong or incomplete: check them before you act on them.",
      ],
    },
    {
      heading: "Credits and scans",
      paragraphs: [
        "Every run, one-off or scheduled, uses one credit of its scan depth. During the private beta credits are granted by our team; payments arrive later and the price per run will be shown before you pay.",
        "A run that fails for reasons on our side returns its credit once. Recurring scans are saved but do not run on a schedule yet.",
      ],
    },
    {
      heading: "Notification emails",
      paragraphs: [
        "Each scan can email a notice to an address you choose. An address other than your account email must confirm a one-time link before it receives anything, and every notice will carry an unsubscribe link.",
      ],
    },
    {
      heading: "Acceptable use",
      paragraphs: [
        "Do not use Swarm against systems you are not authorised to test, to attack third parties, or to bypass the limits on your account. We may refuse a target, stop a run or close an account that breaks these terms.",
      ],
    },
  ],
};

export const privacy: LegalDocument = {
  title: "Privacy notice",
  summary: `Version ${TERMS_VERSION}. What we keep, why, and how to delete it.`,
  sections: [
    {
      heading: "What we hold",
      paragraphs: [
        "Your email address, the targets, logins, scope notes and scans you save, the runs and reports they produce, your credit balance, and the sign-in sessions on your devices. Your email address is stored only in your profile; everywhere else we use a keyed hash of it.",
        "Test logins are kept as you entered them so the agents can sign in, encrypted at rest in our storage. We never show a saved password back to you: when you edit a target you can replace it, not read it.",
        "We keep the confirmation you gave that you are authorised to test, with its time, your network address and the terms version.",
      ],
    },
    {
      heading: "Where it lives",
      paragraphs: [
        "Everything is stored in Amazon Web Services in Sydney, Australia (ap-southeast-2). Email is sent through Amazon SES. Models run through Amazon Bedrock using Australian inference profiles, and your data is not used to train models. Payments, when they arrive, will be handled by Stripe.",
      ],
    },
    {
      heading: "Deleting your data",
      paragraphs: [
        "You can delete a single run, a scan, a target (which also deletes the scans on it), or your whole account from the dashboard, scans and account pages. Deletion is permanent: storage is not versioned, so there is no copy to restore.",
        "Deleting your account needs a fresh code we email you. It cancels anything running, then removes your profile, sessions, targets and saved logins, scans, runs, reports, evidence and credit balance, and emails you a confirmation.",
      ],
    },
    {
      heading: "What we keep after deletion",
      paragraphs: [
        "Anonymised cost records: scan depth, timings, counts of tokens and requests, and cost. They contain no email address, no target, no findings and no link back to you.",
        "A staff-granted credit is recorded in an audit log that holds a one-way hash of your email address (not the address itself), the depth, the amount, the reason and who granted it.",
        "If an address bounces or reports one of our emails as spam, a one-way hash of that address is kept so we stop emailing it. Payment records that tax law requires will be kept once payments exist.",
      ],
    },
    {
      heading: "Who can see it",
      paragraphs: [
        "Only you, through your signed-in session, and our staff when they are supporting you. Findings, evidence and reports are shown only after you sign in; a notification email carries counts and a link, never the report itself.",
      ],
    },
    {
      heading: "Questions",
      paragraphs: ["Write to support@fhlostonswarm.com."],
    },
  ],
};
