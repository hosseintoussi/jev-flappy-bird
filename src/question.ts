// The one semantic question Jev answers, shared by the server (which asks it)
// and the client (which records it in the exported session log).
//
// It is a two-option Choice: Jev picks FLAP or WAIT itself. There is no threshold
// or other decision rule in the app; `choice` is used exactly as returned.
//
// The option descriptions say where the bird is relative to the gap, not what
// physics will do. Describing FLAP as "falling toward the bottom" made Jev flap
// whenever the bird was falling, even above the gap and into the top pipe. Listing
// plain "rising" as a WAIT reason made it stop climbing while still below the gap.
// A "falling fast and close to the bottom" FLAP clause made it a coin flip (P(flap) ~0.5)
// whenever the bird was falling fast *above* a lower gap, and that flap into the upper pipe
// was the most common death. The options now use the same words as the state's position label.
export const FLAP_QUESTION = {
  instructions: "What should the bird do right now to pass safely through the gap of the next pipe?",
  criteria: {
    FLAP: "Flap: the bird is below the gap, or is in the lower half of the gap and not rising.",
    WAIT: "Wait: the bird is above the gap (even when falling fast), or is in the upper half of the gap, or is rising inside the gap.",
  },
} as const;
