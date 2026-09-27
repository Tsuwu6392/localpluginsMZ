/*:
 * @target MZ
 * @plugindesc Blocks selected Control Variable operations for selected variable IDs. Portable across vanilla MZ and range-patched cores.
 * @author you
 * @help
 * Place in js/plugins/, enable in Plugin Manager.
 *
 * LOAD ORDER: place this BELOW any other plugin that patches or rewrites
 * Game_Interpreter.prototype.command122 (Control Variables). This plugin
 * detects the current param layout once, at load time, by inspecting
 * whatever command122 already is — so it needs to see the final version.
 *
 * Each rule is: "varId:op1|op2|..."
 *   ops: Set, Add, Sub, Mul, Div, Mod  (or raw numbers 0..5)
 *   Separate multiple ops on the SAME variable with "|" or a space —
 *   NOT a comma. Commas separate different rules from each other.
 *
 * Example: "6:Add, 10:Sub"
 *   -> ignores every "Variable 6 +=" and "Variable 10 -="
 *
 * Example: "6:Add|Sub, 10:Mul Div"
 *   -> ignores "Variable 6 +=" AND "Variable 6 -=", plus
 *      "Variable 10 *=" AND "Variable 10 /="
 *
 * Leave a rule's op list empty to block ALL operations on that variable:
 *   "10:"
 *
 * KNOWN LIMITATION - ranged Control Variables commands:
 *   The event command "Control Variables" can target a RANGE of variable
 *   IDs at once (e.g. variables 8 through 12) rather than a single ID.
 *   This plugin can only block a command outright when it targets exactly
 *   ONE variable. If a ranged command's span includes a blocked variable
 *   ALONGSIDE other, non-blocked variables, the plugin cannot safely
 *   block just the one ID without also stopping the other variables in
 *   that range from updating — so the whole command is allowed to run,
 *   and the blocked variable will still change. Blocking is only
 *   guaranteed when the offending command targets a single variable
 *   (start ID == end ID), which is what the normal editor UI produces
 *   when you pick one specific variable rather than a range.
 *
 * Compatibility:
 *   Detects at load time whether command122 uses vanilla MZ's
 *   [startId, endId, op, operandType, operand, ...] layout (named locals
 *   startId/endId in the function source) or some other core's layout.
 *   If detection is inconclusive, the plugin assumes the modern
 *   [startId, endId, op, ...] shape, since that's what stock MZ has used
 *   since release — this is safer than assuming a single-variable shape.
 *
 * @param rules
 * @text Rules
 * @type string
 * @default 6:Add, 10:Sub
 * @desc Comma-separated list like "6:Add, 10:Sub". Use "|" to combine ops on one var, e.g. "6:Add|Sub". Empty op list blocks all ops.
 *
 * @param logBlocked
 * @text Log Blocked Commands
 * @type boolean
 * @default false
 * @desc If true, prints a console line each time a command is blocked.
 */

(() => {
    const PLUGIN = "VarCommandFilter";
    const params = PluginManager.parameters(PLUGIN);
    const raw = String(params["rules"] || "").trim();
    const LOG = String(params["logBlocked"]) === "true";

    const OP = { Set: 0, Add: 1, Sub: 2, Mul: 3, Div: 4, Mod: 5 };
    const parseOp = (s) => {
        s = String(s).trim();
        if (Object.prototype.hasOwnProperty.call(OP, s)) return OP[s];
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    };

    // ---- Feature detection ----------------------------------------------
    // Inspect the live command122 source to figure out which param layout
    // is in play.
    //   Range-style (stock MZ):  params[0]=startId, params[1]=endId, params[2]=op
    //   Single-var (e.g. MV-style ports): params[0]=varId, params[1]=op
    // If we can't tell, default to the range-style layout — that's what
    // unmodified MZ has always shipped with, so it's the safer guess.
    const src = Game_Interpreter.prototype.command122.toString();
    const HAS_START = /\bstartId\b/.test(src);
    const HAS_END = /\bendId\b/.test(src);
    const RANGE_LAYOUT = HAS_START && HAS_END;

    if (!HAS_START && !HAS_END) {
        console.warn(`[${PLUGIN}] Could not confirm command122's param layout ` +
            `from source inspection. Assuming stock MZ's range-style layout ` +
            `([startId, endId, op, ...]). If blocking doesn't work as expected, ` +
            `check load order relative to any other plugin patching Control Variables.`);
    }

    const IDX = RANGE_LAYOUT
        ? { start: 0, end: 1, op: 2 }
        : { start: 0, end: 0, op: 1 };

    console.log(`[${PLUGIN}] layout = ${RANGE_LAYOUT ? "range-style" : "single-variable"}`);

    // ---- Rule parsing ------------------------------------------------------
    /** @type {Map<number, Set<number>|null>} varId -> blocked op set (null = all ops) */
    const BLOCKED = new Map();

    for (const rule of raw.split(",")) {
        const [idPart, opPartRaw] = rule.split(":");
        const id = Number((idPart || "").trim());
        if (!Number.isFinite(id)) continue;

        const opPart = (opPartRaw || "").trim();
        if (opPart === "") {
            BLOCKED.set(id, null);
        } else {
            const set = new Set();
            for (const name of opPart.split(/[|+\s]+/).filter(Boolean)) {
                const code = parseOp(name);
                if (code !== null) set.add(code);
            }
            BLOCKED.set(id, set);
        }
    }

    console.log(`[${PLUGIN}] rules =`, raw,
        "parsed =", [...BLOCKED.entries()].map(([v, s]) => [v, s === null ? "ALL" : [...s]]));

    // ---- Hook ---------------------------------------------------------------
    const _command122 = Game_Interpreter.prototype.command122;
    Game_Interpreter.prototype.command122 = function(params) {
        const startId = params[IDX.start];
        const endId   = RANGE_LAYOUT ? params[IDX.end] : startId;
        const op      = params[IDX.op];

        for (const [varId, ops] of BLOCKED) {
            if (startId <= varId && varId <= endId) {
                if (ops === null || ops.has(op)) {
                    if (LOG) {
                        console.log(`[${PLUGIN}] blocked range ${startId}..${endId} op=${op} (target var ${varId})`);
                    }
                    // Only consume when the command affects exactly one variable.
                    // Multi-var ranges fall through so the other vars still update
                    // (see "KNOWN LIMITATION" in @help).
                    if (startId === endId) return true;
                }
            }
        }
        return _command122.call(this, params);
    };
})();
