/*:
 * @target MZ
 * @plugindesc (MV/MZ) Blocks selected Control Variable operations for selected variable IDs.
 * @author you
 * @help
 * Works in both RPG Maker MV and MZ.
 * Place in js/plugins/, enable in Plugin Manager.
 *
 * LOAD ORDER: place this BELOW any other plugin that patches or rewrites
 * Game_Interpreter.prototype.command122 (Control Variables), so this
 * plugin wraps the final version.
 *
 * Each rule is: "varId:op1|op2|..."
 *   ops: Set, Add, Sub, Mul, Div, Mod  (or raw numbers 0..5)
 *   Separate multiple ops on the SAME variable with "|" or a space -
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
 *   that range from updating - so the whole command is allowed to run,
 *   and the blocked variable will still change. Blocking is only
 *   guaranteed when the offending command targets a single variable
 *   (start ID == end ID), which is what the normal editor UI produces
 *   when you pick one specific variable rather than a range.
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
        // MZ passes params as an argument; MV keeps them on this._params.
        const p = params || this._params;
        const startId = p[0];
        const endId   = p[1];
        const op      = p[2];

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
