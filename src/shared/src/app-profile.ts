import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * What the explorer understood about the application: the "what we understood" section of the
 * report. It is written from what the swarm saw (pages, forms, navigation), so it is described as
 * an understanding, never as fact. Customer-facing, and every value originates in the target's own
 * content, so renderers must treat it as untrusted text.
 */
export const appProfileSchema = z.object({
  purpose: text(1000),
  /** The features or sections of the application. */
  areas: z
    .array(
      z.object({
        name: text(100),
        description: text(500),
        path: z.string().trim().max(300).optional(),
        /** True when the area was only reachable while signed in. */
        requiresLogin: z.boolean(),
      }),
    )
    .max(30),
  /** The roles seen or declared, and how their access differs. */
  roles: z
    .array(
      z.object({
        name: text(100),
        description: text(500),
        /** What this role could reach, by area name. */
        access: z.array(text(120)).max(20),
      }),
    )
    .max(10),
  /** The main things a user does. */
  flows: z.array(z.object({ name: text(100), description: text(500) })).max(10),
  /** Frameworks, libraries and services the pages gave away. */
  technologies: z.array(text(80)).max(20),
  coverage: z.object({
    pagesVisited: z.number().int().nonnegative(),
    loginsUsed: z.number().int().nonnegative(),
    signedIn: z.boolean(),
  }),
});
export type AppProfile = z.infer<typeof appProfileSchema>;
