/*:
 * @target MZ
 * @plugindesc (MV/MZ) Clamps selected Control Variable operations at a threshold.
 * @author you
 * @help
 * Works in both RPG Maker MV and MZ.
 * Place in js/plugins/, enable in Plugin Manager.
 *
 * LOAD ORDER: place this BELOW any other plugin that patches or rewrites
 * Game_Interpreter.prototype.command122 (Control Variables), so this
 * plugin wraps the final version.
 *
 * Each rule is: VALUE_ID, OPERATION, VALUE
 *   VALUE_ID   the variable ID
 *   OPERATION  Set, Add, Sub, Mul, Div, Mod (or raw numbers 0..5).
 *              Combine several with "|" (e.g. Add|Sub). Leave empty for ALL.
 *   VALUE      the threshold (optional, see below)
 *
 * Separate rules from each other with ";" (or a new line).
 *
 * HOW THE THRESHOLD WORKS
 *   The threshold is applied in the direction the command moved the variable:
 *   - If the operation DECREASED the variable and the result is
 *     equal to or below VALUE, the variable is set back to VALUE.
 *   - If the operation INCREASED the variable and the result is
 *     equal to or above VALUE, the variable is set back to VALUE.
 *
 *   So for Sub, VALUE acts as a floor. For Add, VALUE acts as a ceiling.
 *
 * Examples:
 *   "10, Sub, 0"
 *   -> Variable 10 can never be reduced by Sub to 0 or below; it is set to 0.
 *
 *   "10, Sub, 0; 6, Add, 99"
 *   -> Variable 10 floors at 0 on Sub, variable 6 caps at 99 on Add.
 *
 * Leave VALUE out entirely to BLOCK the operation instead of clamping it
 * (the variable is restored to what it was before the command ran):
 *   "6, Add"     or     "10, Sub|Mul,"
 *
 * FLIP
 *   Write Flip as the VALUE to mirror the change instead of blocking it:
 *   the variable or stat moves by the same amount in the opposite direction.
 *   "10, Sub, Flip"   -> a Sub that lowers variable 10 by 3 raises it by 3.
 *   "TP, Sub, Flip"   -> a -5 TP change becomes +5.
 *   Flip works on the change that actually happened (old vs. new value), so
 *   with Set/Mul/Div/Mod it mirrors the resulting difference. HP/MP/TP stay
 *   within their normal range. An empty operation flips both directions,
 *   which inverts every change, so usually name Sub or Add.
 *
 * Ranged Control Variables commands (e.g. variables 8 through 12) are
 * handled per variable, so only the ruled variable is clamped/restored
 * and the others in the range update normally.
 *
 * Note: variable rules only filter the Control Variables event command.
 * Script calls such as $gameVariables.setValue() are not affected.
 *
 * HP / MP / TP RULES
 *   Use HP, MP or TP in place of a variable ID to guard the stat itself.
 *   Format: STAT, OPERATION, VALUE, WHO
 *   OPERATION  Sub = decreases, Add = increases. Empty = both.
 *              (Set/Mul/Div/Mod can't be told apart at this level.)
 *   VALUE      same threshold rule as above. Omit it to BLOCK the change.
 *   WHO        optional. Empty = all actors, an actor ID = that actor only,
 *              Enemies = enemies only, All = actors and enemies.
 *
 *   These act on the stat, so they catch Change HP/MP/TP commands, skill
 *   costs, damage, drain effects and plugin changes. A variable that mirrors
 *   the stat (e.g. via a Script operand) follows it automatically, so it
 *   needs no rule of its own.
 *
 *   Examples:
 *   "TP, Sub"          -> actors' TP can never decrease.
 *   "MP, Sub, 5"       -> a drop to 5 MP or below sets MP to 5.
 *   "HP, Sub, 1, 1"    -> actor 1 can't be reduced below 1 HP.
 *   "TP, Sub, , 2"     -> only actor 2's TP is protected.
 *
 *   Not covered: instant-death states set HP to 0 directly.
 *
 * @param rules
 * @text Rules
 * @type string
 * @default
 * @desc "VALUE_ID, OPERATION, VALUE" rules separated by ";". Use HP/MP/TP as the ID for stat rules ("TP, Sub"). Omit VALUE to block. Empty = no rules.
 *
 * @param logBlocked
 * @text Log Clamped/Blocked Commands
 * @type boolean
 * @default false
 * @desc If true, prints a console line each time a rule fires.
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
        if (s === "") return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    };

    // ---- Rule parsing ------------------------------------------------------
    /** @type {{id:number, ops:Set<number>|null, limit:number|null}[]} */
    const RULES = [];
    /** @type {{stat:string, dir:string|null, limit:number|null, who:string|number}[]} */
    const STAT_RULES = [];

    for (const rule of raw.split(/[;\n]+/)) {
        if (rule.trim() === "") continue;
        const parts = rule.split(",").map((s) => s.trim());

        const stat = /^(hp|mp|tp)$/i.test(parts[0]) ? parts[0].toLowerCase() : null;
        const id = stat ? 0 : Number(parts[0]);
        if (!stat && (parts[0] === "" || !Number.isFinite(id))) continue;

        // Operation(s): empty = all operations.
        let ops = null;
        if (parts[1]) {
            ops = new Set();
            for (const name of parts[1].split(/[|+\s]+/).filter(Boolean)) {
                const code = parseOp(name);
                if (code !== null) ops.add(code);
            }
            if (ops.size === 0) continue; // nothing valid was given
        }

        // Stat rules only know the direction of change: Sub = down, Add = up.
        let dir = null;
        if (stat && ops) {
            const dec = ops.has(2), inc = ops.has(1);
            if (!dec && !inc) continue;
            dir = dec && inc ? null : (dec ? "dec" : "inc");
        }

        // Threshold: empty/missing = block instead of clamp.
        let limit = null, flip = false;
        if (/^flip$/i.test(parts[2] || "")) {
            flip = true;
        } else if (parts[2] !== undefined && parts[2] !== "") {
            const n = Number(parts[2]);
            if (!Number.isFinite(n)) continue;
            limit = n;
        }

        if (stat) {
            let who = "actors";
            if (parts[3]) {
                const w = parts[3].toLowerCase();
                if (w === "all" || w === "enemies") who = w;
                else if (Number.isFinite(Number(w))) who = Number(w);
                else continue;
            }
            STAT_RULES.push({ stat, dir, limit, flip, who });
        } else {
            RULES.push({ id, ops, limit, flip });
        }
    }

    console.log(`[${PLUGIN}] rules =`, raw,
        "parsed =", RULES.map((r) => [r.id, r.ops === null ? "ALL" : [...r.ops], r.flip ? "FLIP" : r.limit]));

    // ---- Hook ---------------------------------------------------------------
    const _command122 = Game_Interpreter.prototype.command122;
    Game_Interpreter.prototype.command122 = function(params) {
        // MZ passes params as an argument; MV keeps them on this._params.
        const p = params || this._params;
        const startId = p[0];
        const endId   = p[1];
        const op      = p[2];

        // Rules that apply to this command, plus each variable's value beforehand.
        const active = RULES.filter((r) =>
            startId <= r.id && r.id <= endId && (r.ops === null || r.ops.has(op)));
        if (active.length === 0) return _command122.call(this, params);

        const before = new Map();
        for (const r of active) {
            if (!before.has(r.id)) before.set(r.id, $gameVariables.value(r.id));
        }

        const result = _command122.call(this, params);

        for (const r of active) {
            const old = before.get(r.id);
            const now = $gameVariables.value(r.id);
            if (now === old) continue;

            if (r.flip) {
                // Flip: mirror the change around the old value.
                if (typeof old === "number" && typeof now === "number") {
                    const flipped = old - (now - old);
                    $gameVariables.setValue(r.id, flipped);
                    if (LOG) console.log(`[${PLUGIN}] flipped var ${r.id} op=${op}: ${now} -> ${flipped}`);
                }
            } else if (r.limit === null) {
                // Block: put it back exactly as it was.
                $gameVariables.setValue(r.id, old);
                if (LOG) console.log(`[${PLUGIN}] blocked var ${r.id} op=${op}: ${now} -> ${old}`);
            } else if (
                (now < old && now <= r.limit) ||   // decreased to/below threshold
                (now > old && now >= r.limit)      // increased to/above threshold
            ) {
                $gameVariables.setValue(r.id, r.limit);
                if (LOG) console.log(`[${PLUGIN}] clamped var ${r.id} op=${op}: ${now} -> ${r.limit}`);
            }
        }
        return result;
    };

    // ---- HP / MP / TP hooks -------------------------------------------------
    const FIELDS  = { hp: "_hp",   mp: "_mp",   tp: "_tp" };
    const SETTERS = { hp: "setHp", mp: "setMp", tp: "setTp" };

    const appliesTo = (r, b) => {
        if (r.who === "all") return true;
        if (r.who === "enemies") return b.isEnemy();
        if (!b.isActor()) return false;
        return r.who === "actors" || b.actorId() === r.who;
    };

    // Returns the value the stat should end up with once the rules are applied.
    const guard = (b, stat, old, next) => {
        for (const r of STAT_RULES) {
            if (r.stat !== stat || next === old || !appliesTo(r, b)) continue;
            const dec = next < old;
            if (r.dir === "dec" && !dec) continue;
            if (r.dir === "inc" && dec) continue;
            let out = next;
            if (r.flip) out = old - (next - old);
            else if (r.limit === null) out = old;
            else if ((dec && next <= r.limit) || (!dec && next >= r.limit)) out = r.limit;
            if (out !== next) {
                if (LOG) console.log(`[${PLUGIN}] ${stat.toUpperCase()} ${old} -> ${next} changed to ${out}`);
                next = out;
            }
        }
        return next;
    };

    if (STAT_RULES.length > 0) {
        // setHp/setMp/setTp cover Change HP/MP/TP, damage, drain and gain effects.
        for (const stat of Object.keys(FIELDS)) {
            if (!STAT_RULES.some((r) => r.stat === stat)) continue;
            const field = FIELDS[stat];
            const _set = Game_BattlerBase.prototype[SETTERS[stat]];
            Game_BattlerBase.prototype[SETTERS[stat]] = function(value) {
                return _set.call(this, guard(this, stat, this[field], value));
            };
        }

        // Skill costs subtract _mp/_tp directly, bypassing the setters.
        const _pay = Game_BattlerBase.prototype.paySkillCost;
        Game_BattlerBase.prototype.paySkillCost = function(skill) {
            const oldMp = this._mp, oldTp = this._tp;
            _pay.call(this, skill);
            this._mp = guard(this, "mp", oldMp, this._mp).clamp(0, this.mmp);
            this._tp = guard(this, "tp", oldTp, this._tp).clamp(0, this.maxTp());
        };
    }
})();
