const EventEmitter = require("events");

class LobsterScheduler extends EventEmitter {
  constructor(options) {
    super();
    this.adapter = options.adapter;
    this.store = options.store;
    this.intervalMs = options.intervalMs || 5000;
    this.timer = null;
    this.running = false;
    this.inFlight = false;
    this.nextIndex = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.emit("error", error);
      });
    }, this.intervalMs);
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.inFlight) return null;
    this.inFlight = true;
    let selectedOpenClawId = null;

    try {
      const schedulableOpenClawIds = await this.store.listSchedulableOpenClawIds();
      if (!schedulableOpenClawIds.length) {
        return null;
      }

      const openClawId = schedulableOpenClawIds[this.nextIndex % schedulableOpenClawIds.length];
      selectedOpenClawId = openClawId;
      this.nextIndex = (this.nextIndex + 1) % schedulableOpenClawIds.length;

      const input = await this.store.buildTickInput(openClawId);
      const output = await this.adapter.runTick(input);
      const result = await this.store.applyTickOutput(output, input.now, openClawId);
      const diagnosticEvents = [];

      if (output.debugSummary) {
        const debugEvent = await this.store.recordDiagnosticEvent(
          output.diagnosticEventType || "adapter_debug",
          output.debugSummary,
          {
            actionType: output.actionType,
            source: this.adapter.mode,
          },
          input.now,
          openClawId
        );
        diagnosticEvents.push(debugEvent);
      }

      this.emit("runtime", result.runtime);
      for (const event of result.events || [result.event]) {
        this.emit("event", event);
      }

      for (const diagnosticEvent of diagnosticEvents) {
        this.emit("diagnostic", diagnosticEvent);
      }

      this.emit("relationship_changed", {
        lobsterId: input.lobsterId,
        openClawId: input.lobsterId,
        relationships: result.relationshipChanges,
      });

      return result;
    } catch (error) {
      const happenedAt = new Date().toISOString();
      console.warn(`[scheduler] tick failed, skipping: ${error.message}`);
      try {
        const diagnosticEvent = await this.store.recordDiagnosticEvent(
          "scheduler_error",
          error.message,
          {
            name: error.name,
            stack: error.stack,
          },
          happenedAt,
          selectedOpenClawId
        );
        this.emit("diagnostic", diagnosticEvent);
      } catch (diagError) {
        console.warn(`[scheduler] failed to record diagnostic: ${diagError.message}`);
      }
    } finally {
      this.inFlight = false;
    }
  }
}

module.exports = {
  OpenClawScheduler: LobsterScheduler,
  LobsterScheduler,
};
