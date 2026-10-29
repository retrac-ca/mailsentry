import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RoadmapItem, RoadmapSection } from "../shared/types.js";

/**
 * Parse the project's ROADMAP.md so the UI shows the file's real state.
 * Supported item markers: [x] complete, [~] in progress, [!] blocked, [ ] planned.
 */
export function parseRoadmap(markdown: string): RoadmapSection[] {
  const sections: RoadmapSection[] = [];
  let current: RoadmapSection | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading?.[1]) {
      current = { title: heading[1], items: [] };
      sections.push(current);
      continue;
    }
    const item = /^\s*-\s+\[( |x|X|~|!)\]\s+(.+?)\s*$/.exec(line);
    if (!item || !current) continue;
    const marker = item[1];
    const status =
      marker === "x" || marker === "X"
        ? "complete"
        : marker === "~"
          ? "in-progress"
          : marker === "!"
            ? "blocked"
            : "planned";
    current.items.push({
      text: (item[2] ?? "").replace(/\s+/g, " "),
      status: status as RoadmapItem["status"],
    });
  }
  return sections.filter((section) => section.items.length > 0);
}

export async function loadRoadmap(rootDir: string): Promise<RoadmapSection[]> {
  try {
    const markdown = await readFile(resolve(rootDir, "ROADMAP.md"), "utf8");
    return parseRoadmap(markdown);
  } catch {
    return [];
  }
}
