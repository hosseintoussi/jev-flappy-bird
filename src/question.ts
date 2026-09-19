// The one question Jev answers. Shared by the server, which asks it, and the client,
// which records it in the exported session log.
//
// The options say where the bird is, in the same words as the state's position label.
// They never mention what physics will do: an option that said "falling fast" made Jev
// flap whenever the bird fell fast, even above the gap, where it needs to fall.
export const FLAP_QUESTION = {
  instructions: "What should the bird do right now to pass safely through the gap of the next pipe?",
  criteria: {
    FLAP: "Flap: the bird is below the gap, or is in the lower half of the gap and not rising.",
    WAIT: "Wait: the bird is above the gap (even when falling fast), or is in the upper half of the gap, or is rising inside the gap.",
  },
} as const;
