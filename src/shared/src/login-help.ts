/**
 * Why a sign-in on the customer's application failed, and the fix the customer can make on their
 * staging environment (docs/LOGIN.md section 3). The explorer, the report's gap text and the intake
 * form all read this one map, so the wording cannot drift.
 */
export const SIGN_IN_OBSTACLES = [
  "no-form",
  "sso",
  "second-factor",
  "captcha",
  "refused",
  "still-showing",
] as const;

export type SignInObstacle = (typeof SIGN_IN_OBSTACLES)[number];

export const loginHelp: Record<SignInObstacle, string> = {
  "no-form":
    "No sign-in form with a password or passcode field was found. Say in the login's notes which page has the sign-in form, or give the test user a local username and password sign-in.",
  sso: "The sign-in page offers only single sign-on (Google, Microsoft, Okta or similar). Give the test user a local username and password, or turn single sign-on off for the test environment.",
  "second-factor":
    "The sign-in asks for a second factor (an authenticator, SMS, email or push code). Exempt the test user from multi-factor authentication, or set a fixed test passcode and enter it as the password.",
  captcha:
    "The sign-in page is protected by a CAPTCHA. Disable it for the test user, or allow-list our requests (they carry the User-Agent `Swarm/<version> (+https://fhlostonswarm.com/about)`).",
  refused:
    "The application refused the saved username and password or passcode. Check that the account exists, is approved and unlocked, and that the saved login is current, then scan again.",
  "still-showing":
    "The sign-in form was submitted but the application did not sign in. Check the saved login works by hand on the test environment, or describe how the sign-in works in the login's notes.",
};

/** The obstacles the customer can remove with a change to their test environment, for the intake note. */
export const LOGIN_BYPASS_NOTES: readonly SignInObstacle[] = ["sso", "second-factor", "captcha"];
