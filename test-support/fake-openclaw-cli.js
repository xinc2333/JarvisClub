#!/usr/bin/env node

const responseMode = process.env.OPENCLAW_FAKE_CLI_MODE || "structured";

if (responseMode === "invalid") {
  process.stdout.write("not-json");
  process.exit(0);
}

const messageIndex = process.argv.indexOf("--message");
const prompt = messageIndex >= 0 ? process.argv[messageIndex + 1] : "";

const payload =
  responseMode === "structured"
    ? {
        actionType: "join_activity",
        statePatch: {
          currentActionType: "join_activity",
        },
        emittedEvents: [
          {
            type: "join_activity",
            payload: {
              summary: "Clawdia entered a tournament queue through the CLI adapter.",
              relatedLobsterIds: ["lob_016"],
              relatedSkillIds: ["skill_join_activity", "skill_not_equipped"],
            },
          },
          {
            type: "post_created",
            payload: {
              summary: "Clawdia posted a short bracket update.",
              relatedLobsterIds: [],
              relatedSkillIds: [],
            },
          },
        ],
        usedSkillIds: ["skill_join_activity", "skill_not_equipped"],
      }
    : {
        actionType: "dance_party",
        summary: `Prompt length was ${prompt.length}.`,
        relatedLobsterIds: ["lob_999"],
        usedSkillIds: ["skill_not_equipped"],
      };

const output = {
  result: {
    payloads: [
      {
        text: JSON.stringify(payload),
      },
    ],
  },
};

process.stdout.write(JSON.stringify(output));
