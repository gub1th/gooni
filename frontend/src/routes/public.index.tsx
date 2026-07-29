import { createFileRoute } from "@tanstack/react-router";
import { CreativeExperience } from "../components/creative/CreativeExperience";

// /public is the company-facing portfolio front door: the creative plaza
// scene. Jump in the hole -> /walk; "the short version" -> /public/cv.
// The old notes index moved to /public/notes.
export const Route = createFileRoute("/public/")({
  component: CreativeExperience,
});
