import type { RoadmapItem } from "../../shared/types.js";
import { ApiError, loadRoadmap } from "../api.js";
import type { View } from "../context.js";
import { alertBox, badge, clear, emptyState, h } from "../dom.js";

const STATUS_LABEL: Record<RoadmapItem["status"], string> = {
  complete: "Complete",
  "in-progress": "In progress",
  planned: "Planned",
  blocked: "Blocked",
};

export const renderRoadmap: View = (root) => {
  const slot = h("div", {});
  let disposed = false;

  root.append(
    h("div", { class: "page-head" }, [
      h("div", {}, [
        h("div", { class: "eyebrow", text: "Project status" }),
        h("h1", { text: "Roadmap" }),
        h("p", {
          text: "This view is generated from the repository's ROADMAP.md. Statuses reflect what is implemented, not aspirations.",
        }),
      ]),
    ]),
    slot,
  );

  const render = async (): Promise<void> => {
    clear(slot);
    slot.append(h("p", { class: "muted", text: "Loading roadmap…" }));
    try {
      const sections = await loadRoadmap();
      if (disposed) return;
      clear(slot);
      if (sections.length === 0) {
        slot.append(
          emptyState("Roadmap unavailable", "ROADMAP.md could not be read from the project directory."),
        );
        return;
      }
      slot.append(
        h(
          "div",
          { class: "grid two" },
          sections.map((section) =>
            h(
              "section",
              { class: "card", "aria-labelledby": `roadmap-${section.title.replace(/\W+/g, "-")}` },
              [
                h("h2", { id: `roadmap-${section.title.replace(/\W+/g, "-")}`, text: section.title }),
                h(
                  "ul",
                  { class: "check-list" },
                  section.items.map((item) =>
                    h("li", { class: "check" }, [
                      h("span", { class: "check-text" }, [
                        h("strong", { text: item.text }),
                        badge(STATUS_LABEL[item.status], item.status),
                      ]),
                    ]),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
      slot.append(
        h("p", {
          class: "small muted section",
          text: "Statuses are parsed from markdown checkboxes: [x] complete, [~] in progress, [!] blocked, [ ] planned.",
        }),
      );
    } catch (error) {
      if (disposed) return;
      clear(slot);
      slot.append(
        alertBox("danger", "Could not load roadmap", [
          h("p", { text: error instanceof ApiError ? error.message : "ROADMAP.md is unavailable." }),
        ]),
      );
    }
  };

  void render();
  return () => {
    disposed = true;
  };
};
