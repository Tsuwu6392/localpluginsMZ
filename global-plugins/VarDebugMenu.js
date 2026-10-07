/*:
 * @target MZ
 * @plugindesc (MV/MZ) In-game debug menu that controls how variables and HP/MP/TP are allowed to change.
 * @author you
 * @help
 * Works in both RPG Maker MV and MZ.
 * Place in js/plugins/ and enable in the Plugin Manager. The file name
 * can be anything; the plugin reads its own name.
 *
 * OPENING THE MENU
 *   Press the hotkey (default V) to open or close the menu. Esc also closes
 *   it. The game keeps running underneath, but game input is blocked while
 *   the menu is open. Two tabs: Variables and Stats.
 *   The search box matches IDs, names and current values (type 10 to find
 *   variable 10 and any variable currently holding 10).
 *
 * EACH ROW HAS
 *   Direction   Up / Down / Any   which kind of change the rule reacts to.
 *   Mode        Flip / Input
 *   Value       a number (only used by Input).
 *
 *   Flip   mirrors the change around the old value.
 *            Up   Flip   an increase of 3 becomes a decrease of 3.
 *            Down Flip   a decrease of 3 becomes an increase of 3.
 *            Any  Flip   every change is inverted.
 *
 *   Input  keeps the value from passing the number you type.
 *            Up   10   can't go above 10 (an increase is capped at 10).
 *            Down 10   can't go below 10 (a decrease is floored at 10).
 *            Any  10   locked at 10. If it is not 10 now, it is set to 10
 *                      immediately, and every later change is forced to 10.
 *
 *   Input with an empty Value does nothing, so a row left on its defaults
 *   (Any, Input, empty) has no rule.
 *
 * VARIABLES TAB
 *   Rules hook Game_Variables.setValue, so they apply to Control Variables
 *   event commands, ranged commands (each variable on its own), and script
 *   calls alike. Load order doesn't matter.
 *
 * STATS TAB
 *   HP, MP and TP rules for a target: All actors, Enemies, Everyone, or one
 *   specific actor. They act on the stat itself, so they catch Change
 *   HP/MP/TP commands, skill costs, damage, drain and plugin changes.
 *   HP/MP/TP still stay within their normal range afterwards.
 *   Enemy rules are applied when a battle starts.
 *   Not covered: instant-death states set HP to 0 directly.
 *   If several rules match one battler (e.g. "All actors" and "Actor 2"),
 *   all of them apply, in list order.
 *
 * SAVING
 *   Rules are stored in the game's config data (the same place as the
 *   Options menu settings), so they survive restarting the game. They are
 *   shared by all save slots, not stored per slot. Use "Clear all rules"
 *   in the menu to wipe them.
 *
 * NOTES
 *   - Flip only works on numbers. Non-number variable values pass through.
 *   - Variables are whole numbers, so decimals in Value are rounded down.
 *
 * @param hotkey
 * @text Hotkey
 * @type string
 * @default V
 * @desc Key that opens/closes the menu. A letter ("V") or a key name ("F8", "Tab").
 *
 * @param playtestOnly
 * @text Playtest Only
 * @type boolean
 * @default false
 * @desc If true, the menu only opens when the game is started from the editor's Playtest.
 *
 * @param logAdjusted
 * @text Log Adjusted Changes
 * @type boolean
 * @default false
 * @desc If true, prints a console line each time a rule changes a value.
 */

(() => {
    "use strict";

    const script = document.currentScript;
    const PLUGIN = script && script.src
        ? decodeURIComponent(script.src.split("/").pop()).replace(/\.js.*$/i, "")
        : "VarDebugMenu";
    const params = PluginManager.parameters(PLUGIN);

    const HOTKEY = String(params["hotkey"] || "V").trim().toLowerCase() || "v";
    const PLAYTEST_ONLY = String(params["playtestOnly"]) === "true";
    const LOG = String(params["logAdjusted"]) === "true";
    const PER_PAGE = 40;

    const STATS = ["hp", "mp", "tp"];
    const FIELDS = { hp: "_hp", mp: "_mp", tp: "_tp" };
    const SETTERS = { hp: "setHp", mp: "setMp", tp: "setTp" };
    const GROUP_SCOPES = [["actors", "All actors"], ["enemies", "Enemies"], ["all", "Everyone"]];

    // ========================================================================
    // Rule state
    // ========================================================================
    // Keys: "v:<id>" for variables, "s:<stat>:<who>" for stats.
    // who = "actors" | "enemies" | "all" | <actor id>
    const KEY_PATTERN = /^(v:\d+|s:(hp|mp|tp):(actors|enemies|all|\d+))$/;

    /** What the menu shows for each row. key -> {dir, mode, text} */
    const state = {};
    /** Compiled, active variable rules. id -> {dir, flip, limit} */
    const VAR_RULES = {};
    /** Compiled, active stat rules. key -> {stat, who, dir, flip, limit} */
    const STAT_RULES = {};

    const getState = (key) => state[key] || (state[key] = { dir: "any", mode: "input", text: "" });

    const isRuled = (key) => (key.charAt(0) === "v" ? !!VAR_RULES[key.slice(2)] : !!STAT_RULES[key]);

    const compile = (key) => {
        const isVar = key.charAt(0) === "v";
        const parts = key.split(":");
        const s = state[key];
        let rule = null;
        if (s) {
            if (s.mode === "flip") {
                rule = { dir: s.dir, flip: true, limit: 0 };
            } else {
                const t = s.text.trim();
                const n = t === "" ? NaN : Number(t);
                if (Number.isFinite(n)) rule = { dir: s.dir, flip: false, limit: Math.floor(n) };
            }
        }
        if (rule && !isVar) {
            rule.stat = parts[1];
            rule.who = /^\d+$/.test(parts[2]) ? Number(parts[2]) : parts[2];
        }
        const store = isVar ? VAR_RULES : STAT_RULES;
        const k = isVar ? parts[1] : key;
        if (rule) store[k] = rule; else delete store[k];
    };

    /** Returns the value the target should actually receive. */
    const adjust = (rule, old, next) => {
        // Any + Input: locked to the limit, whatever happens.
        if (!rule.flip && rule.dir === "any") return rule.limit;

        if (typeof old !== "number" || typeof next !== "number" || next === old) return next;
        const up = next > old;
        if (rule.dir === "up" && !up) return next;
        if (rule.dir === "down" && up) return next;

        if (rule.flip) return old - (next - old);
        return up ? Math.min(next, rule.limit) : Math.max(next, rule.limit);
    };

    // ---- Persistence (ConfigManager) ---------------------------------------
    const serialize = () => {
        const out = [];
        for (const key in state) {
            if (!isRuled(key)) continue;
            const s = state[key];
            out.push([key, s.dir, s.mode, s.text]);
        }
        return out;
    };

    const restore = (data) => {
        for (const k in state) delete state[k];
        for (const k in VAR_RULES) delete VAR_RULES[k];
        for (const k in STAT_RULES) delete STAT_RULES[k];
        if (!Array.isArray(data)) return;
        for (const e of data) {
            if (!Array.isArray(e) || typeof e[0] !== "string" || !KEY_PATTERN.test(e[0])) continue;
            if (["up", "down", "any"].indexOf(e[1]) < 0 || ["flip", "input"].indexOf(e[2]) < 0) continue;
            state[e[0]] = { dir: e[1], mode: e[2], text: String(e[3] == null ? "" : e[3]) };
            compile(e[0]);
        }
    };

    const _makeData = ConfigManager.makeData;
    ConfigManager.makeData = function() {
        const config = _makeData.call(this);
        config.vdmRules = serialize();
        return config;
    };

    const _applyData = ConfigManager.applyData;
    ConfigManager.applyData = function(config) {
        _applyData.call(this, config);
        restore(config && config.vdmRules);
    };

    let saveTimer = null;
    const scheduleSave = () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            if (typeof ConfigManager.save === "function") ConfigManager.save();
        }, 400);
    };

    // ---- Applying locks immediately ----------------------------------------
    const appliesTo = (r, b) => {
        if (r.who === "all") return true;
        if (r.who === "enemies") return b.isEnemy();
        if (!b.isActor()) return false;
        return r.who === "actors" || b.actorId() === r.who;
    };

    const battlersFor = (who) => {
        const list = [];
        if (who === "actors" || who === "all") {
            if (typeof $gameParty !== "undefined" && $gameParty) list.push(...$gameParty.allMembers());
        }
        if (typeof who === "number" && typeof $gameActors !== "undefined" && $gameActors) {
            const a = $gameActors.actor(who);
            if (a) list.push(a);
        }
        if (who === "enemies" || who === "all") {
            if (typeof $gameTroop !== "undefined" && $gameTroop) list.push(...$gameTroop.members());
        }
        return list;
    };

    // Any + Input rules act immediately, so the target is pulled to the lock.
    const enforceNow = (key) => {
        if (key.charAt(0) === "v") {
            const id = Number(key.slice(2));
            const r = VAR_RULES[id];
            if (typeof $gameVariables === "undefined" || !$gameVariables || !r || r.flip || r.dir !== "any") return;
            $gameVariables.setValue(id, $gameVariables.value(id));
        } else {
            const r = STAT_RULES[key];
            if (!r || r.flip || r.dir !== "any") return;
            for (const b of battlersFor(r.who)) b[SETTERS[r.stat]](b[FIELDS[r.stat]]);
        }
    };

    const enforceAll = () => {
        for (const id in VAR_RULES) enforceNow("v:" + id);
        for (const key in STAT_RULES) enforceNow(key);
    };

    // ========================================================================
    // Hooks
    // ========================================================================
    const _setValue = Game_Variables.prototype.setValue;
    Game_Variables.prototype.setValue = function(variableId, value) {
        const rule = VAR_RULES[variableId];
        if (rule) {
            const old = this.value(variableId);
            const adjusted = adjust(rule, old, value);
            if (LOG && adjusted !== value) {
                console.log(`[${PLUGIN}] var ${variableId}: ${old} -> ${value} changed to ${adjusted}`);
            }
            value = adjusted;
        }
        _setValue.call(this, variableId, value);
    };

    const guardStat = (b, stat, old, next) => {
        for (const key in STAT_RULES) {
            const r = STAT_RULES[key];
            if (r.stat !== stat || !appliesTo(r, b)) continue;
            const out = adjust(r, old, next);
            if (LOG && out !== next) console.log(`[${PLUGIN}] ${stat.toUpperCase()} ${old} -> ${next} changed to ${out}`);
            next = out;
        }
        return next;
    };

    // setHp/setMp/setTp cover Change HP/MP/TP, damage, drain and gain effects.
    for (const stat of STATS) {
        const field = FIELDS[stat];
        const _set = Game_BattlerBase.prototype[SETTERS[stat]];
        Game_BattlerBase.prototype[SETTERS[stat]] = function(value) {
            _set.call(this, guardStat(this, stat, this[field], value));
        };
    }

    // Skill costs subtract _mp/_tp directly, bypassing the setters.
    const _pay = Game_BattlerBase.prototype.paySkillCost;
    Game_BattlerBase.prototype.paySkillCost = function(skill) {
        const oldMp = this._mp, oldTp = this._tp;
        _pay.call(this, skill);
        this._mp = guardStat(this, "mp", oldMp, this._mp).clamp(0, this.mmp);
        this._tp = guardStat(this, "tp", oldTp, this._tp).clamp(0, this.maxTp());
    };

    // Locks loaded from config (or set before a game began) get applied here.
    const _mapStart = Scene_Map.prototype.start;
    Scene_Map.prototype.start = function() {
        _mapStart.call(this);
        enforceAll();
    };
    const _battleStart = Scene_Battle.prototype.start;
    Scene_Battle.prototype.start = function() {
        _battleStart.call(this);
        enforceAll();
    };

    // ========================================================================
    // Menu UI
    // ========================================================================
    const CSS = `
#vdm-root{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:rgba(14,17,24,.62);font:13px/1.4 "Segoe UI",system-ui,-apple-system,sans-serif;color:#e4e8ef;outline:none}
#vdm-root *{box-sizing:border-box}
.vdm-panel{width:min(920px,96vw);height:min(86vh,720px);display:flex;flex-direction:column;
  background:#1c212b;border:1px solid #384152;border-radius:6px;overflow:hidden}
.vdm-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid #384152}
.vdm-title{display:flex;align-items:center;gap:16px}
.vdm-head h2{margin:0;font-size:15px;font-weight:600}
.vdm-tabs{display:flex;gap:6px}
#vdm-root .vdm-tabs button.active{background:#1f3a3d;border-color:#3fc1b0}
.vdm-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid #384152}
.vdm-bar .vdm-grow{flex:1 1 180px;min-width:140px}
.vdm-bar label{display:flex;align-items:center;gap:5px;white-space:nowrap}
.vdm-page{color:#9aa4b5;font-variant-numeric:tabular-nums;white-space:nowrap}
.vdm-scroll{flex:1;overflow:auto}
#vdm-root table{width:100%;border-collapse:collapse}
#vdm-root th{position:sticky;top:0;background:#232a36;text-align:left;font-weight:600;color:#aab3c2;
  padding:7px 10px;border-bottom:1px solid #384152;white-space:nowrap}
#vdm-root td{padding:5px 10px;border-bottom:1px solid #2a3140;vertical-align:middle}
#vdm-root tr.on td{background:#1f3a3d}
#vdm-root tr.on td:first-child{box-shadow:inset 3px 0 0 #3fc1b0}
.vdm-id{color:#9aa4b5;font-variant-numeric:tabular-nums;width:58px}
.vdm-name{max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vdm-now{font-variant-numeric:tabular-nums;width:110px;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#vdm-root select,#vdm-root input[type=text],#vdm-root button{
  font:inherit;color:#e4e8ef;background:#2a3140;border:1px solid #44506a;border-radius:4px;padding:4px 7px}
#vdm-root select{width:84px}
#vdm-root input.vdm-val{width:110px;font-variant-numeric:tabular-nums}
#vdm-root input[type=text]:disabled{opacity:.35}
#vdm-root input.bad{border-color:#e0675a}
#vdm-root button{cursor:pointer}
#vdm-root button:hover:not(:disabled){background:#34405a}
#vdm-root button:disabled{opacity:.4;cursor:default}
#vdm-root :focus-visible{outline:2px solid #3fc1b0;outline-offset:1px}
.vdm-foot{padding:8px 14px;border-top:1px solid #384152;color:#9aa4b5}
.vdm-empty{padding:22px 14px;color:#9aa4b5}
`;

    let root = null, tbody = null, searchBox = null, onlyBox = null;
    let prevBtn = null, nextBtn = null, pageLabel = null, emptyNote = null;
    let thA = null, thB = null, tabBtns = {};
    let isOpen = false, page = 0, filterText = "", onlyRuled = false, tab = "vars";
    let liveCells = [], timer = null;

    const el = (tag, attrs, kids) => {
        const n = document.createElement(tag);
        if (attrs) {
            for (const k in attrs) {
                if (k === "text") n.textContent = attrs[k];
                else if (k === "class") n.className = attrs[k];
                else n.setAttribute(k, attrs[k]);
            }
        }
        if (kids) for (const c of kids) n.appendChild(c);
        return n;
    };

    const makeSelect = (options, value) => {
        const sel = el("select");
        for (const [v, label] of options) sel.appendChild(el("option", { value: v, text: label }));
        sel.value = value;
        return sel;
    };

    const isField = (t) => !!t && (/^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable);

    const isHotkey = (e) =>
        !e.ctrlKey && !e.altKey && !e.metaKey && typeof e.key === "string" && e.key.toLowerCase() === HOTKEY;

    const showValue = (v) => {
        const s = String(v);
        return s.length > 18 ? s.slice(0, 17) + "…" : s;
    };

    const liveText = (item) => {
        if (item.id !== undefined) {
            return typeof $gameVariables !== "undefined" && $gameVariables ? showValue($gameVariables.value(item.id)) : "–";
        }
        if (typeof item.who === "number" && typeof $gameActors !== "undefined" && $gameActors) {
            const a = $gameActors.actor(item.who);
            if (a) return showValue(a[item.stat]);
        }
        return "–";
    };

    const updateLive = () => {
        for (const c of liveCells) {
            const text = liveText(c.item);
            if (text !== c.last) {
                c.cell.textContent = text;
                c.last = text;
            }
        }
    };

    const listItems = () => {
        const q = filterText.trim().toLowerCase();
        const out = [];
        // Matches the ID/stat, the name/target, or the current value.
        const pass = (key, a, b, v) =>
            (!onlyRuled || isRuled(key)) &&
            (!q || a.toLowerCase().indexOf(q) >= 0 || b.toLowerCase().indexOf(q) >= 0 ||
                String(v).toLowerCase().indexOf(q) >= 0);
        const hasVars = typeof $gameVariables !== "undefined" && !!$gameVariables;
        const hasActors = typeof $gameActors !== "undefined" && !!$gameActors;

        if (tab === "vars") {
            const names = $dataSystem ? $dataSystem.variables : [];
            for (let id = 1; id < names.length; id++) {
                const a = String(id), b = String(names[id] || "");
                const v = hasVars ? $gameVariables.value(id) : "";
                if (pass("v:" + id, a, b, v)) out.push({ key: "v:" + id, a, b, id });
            }
        } else {
            const scopes = GROUP_SCOPES.slice();
            const actors = $dataActors || [];
            for (let id = 1; id < actors.length; id++) {
                if (actors[id]) scopes.push([id, `#${id} ${actors[id].name}`]);
            }
            for (const [who, label] of scopes) {
                for (const stat of STATS) {
                    const key = `s:${stat}:${who}`, a = stat.toUpperCase();
                    const actor = hasActors && typeof who === "number" ? $gameActors.actor(who) : null;
                    if (pass(key, a, label, actor ? actor[stat] : "")) out.push({ key, a, b: label, stat, who });
                }
            }
        }
        return out;
    };

    const makeRow = (item) => {
        const key = item.key;
        const s = getState(key);
        const tr = el("tr");
        const now = el("td", { class: "vdm-now" });
        liveCells.push({ item, cell: now, last: null });

        const dirSel = makeSelect([["up", "Up"], ["down", "Down"], ["any", "Any"]], s.dir);
        const modeSel = makeSelect([["flip", "Flip"], ["input", "Input"]], s.mode);
        const input = el("input", { type: "text", class: "vdm-val", placeholder: "number", autocomplete: "off" });
        input.value = s.text;

        const sync = () => {
            input.disabled = s.mode === "flip";
            tr.className = isRuled(key) ? "on" : "";
            const t = s.text.trim();
            input.classList.toggle("bad", s.mode === "input" && t !== "" && !Number.isFinite(Number(t)));
        };
        const changed = () => {
            compile(key);
            enforceNow(key);
            sync();
            updateLive();
            scheduleSave();
        };

        dirSel.addEventListener("change", () => { s.dir = dirSel.value; changed(); });
        modeSel.addEventListener("change", () => { s.mode = modeSel.value; changed(); });
        input.addEventListener("input", () => { s.text = input.value; changed(); });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });

        tr.appendChild(el("td", { class: "vdm-id", text: item.a }));
        tr.appendChild(el("td", { class: "vdm-name", text: item.b, title: item.b }));
        tr.appendChild(now);
        tr.appendChild(el("td", null, [dirSel]));
        tr.appendChild(el("td", null, [modeSel]));
        tr.appendChild(el("td", null, [input]));
        sync();
        return tr;
    };

    const render = () => {
        const items = listItems();
        const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
        page = Math.min(Math.max(page, 0), pages - 1);
        const noun = tab === "vars" ? "variables" : "rows";
        pageLabel.textContent = `Page ${page + 1} of ${pages} (${items.length} ${noun})`;
        prevBtn.disabled = page <= 0;
        nextBtn.disabled = page >= pages - 1;

        thA.textContent = tab === "vars" ? "ID" : "Stat";
        thB.textContent = tab === "vars" ? "Name" : "Target";
        for (const t in tabBtns) tabBtns[t].classList.toggle("active", t === tab);

        tbody.textContent = "";
        liveCells = [];
        for (const item of items.slice(page * PER_PAGE, (page + 1) * PER_PAGE)) tbody.appendChild(makeRow(item));

        emptyNote.style.display = items.length === 0 ? "block" : "none";
        emptyNote.textContent = onlyRuled && !filterText.trim()
            ? "Nothing has a rule yet. Clear “Only with rules” to see everything."
            : "Nothing matches your search.";
        updateLive();
    };

    const build = () => {
        document.head.appendChild(el("style", { text: CSS }));

        root = el("div", { id: "vdm-root", tabindex: "-1" });
        const panel = el("div", { class: "vdm-panel" });

        const closeBtn = el("button", { type: "button", text: "Close", title: "Close (Esc)" });
        closeBtn.addEventListener("click", () => closeMenu());
        tabBtns = {
            vars: el("button", { type: "button", text: "Variables" }),
            stats: el("button", { type: "button", text: "Stats" })
        };
        for (const t in tabBtns) {
            tabBtns[t].addEventListener("click", () => { tab = t; page = 0; render(); });
        }
        const title = el("div", { class: "vdm-title" }, [
            el("h2", { text: "Debug rules" }),
            el("div", { class: "vdm-tabs" }, [tabBtns.vars, tabBtns.stats])
        ]);
        panel.appendChild(el("div", { class: "vdm-head" }, [title, closeBtn]));

        searchBox = el("input", { type: "text", class: "vdm-grow", placeholder: "Search ID, name or value", autocomplete: "off" });
        searchBox.addEventListener("input", () => { filterText = searchBox.value; page = 0; render(); });

        onlyBox = el("input", { type: "checkbox" });
        onlyBox.addEventListener("change", () => { onlyRuled = onlyBox.checked; page = 0; render(); });
        const onlyLabel = el("label", null, [onlyBox, document.createTextNode("Only with rules")]);

        prevBtn = el("button", { type: "button", text: "Previous" });
        nextBtn = el("button", { type: "button", text: "Next" });
        pageLabel = el("span", { class: "vdm-page" });
        prevBtn.addEventListener("click", () => { page--; render(); });
        nextBtn.addEventListener("click", () => { page++; render(); });

        const clearBtn = el("button", { type: "button", text: "Clear all rules" });
        clearBtn.addEventListener("click", () => {
            restore([]);
            scheduleSave();
            render();
        });

        panel.appendChild(el("div", { class: "vdm-bar" }, [searchBox, onlyLabel, prevBtn, pageLabel, nextBtn, clearBtn]));

        tbody = el("tbody");
        thA = el("th");
        thB = el("th");
        const head = el("tr", null, [thA, thB].concat(["Now", "Direction", "Mode", "Value"].map((t) => el("th", { text: t }))));
        const table = el("table", null, [el("thead", null, [head]), tbody]);
        emptyNote = el("div", { class: "vdm-empty" });
        panel.appendChild(el("div", { class: "vdm-scroll" }, [table, emptyNote]));

        panel.appendChild(el("div", {
            class: "vdm-foot",
            text: "Direction Up/Down/Any picks which changes a rule reacts to. Flip reverses them; Input holds the value at your number."
        }));
        root.appendChild(panel);

        // Keep every event inside the menu away from the game's input handlers.
        const swallow = ["keyup", "keypress", "mousedown", "mouseup", "mousemove", "touchstart", "touchend",
            "touchmove", "wheel", "pointerdown", "pointerup", "pointermove", "click", "dblclick", "contextmenu"];
        for (const type of swallow) root.addEventListener(type, (e) => e.stopPropagation());
        root.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.repeat) return;
            const onSelect = e.target && e.target.tagName === "SELECT";
            if ((e.key === "Escape" && !onSelect) || (isHotkey(e) && !isField(e.target))) {
                e.preventDefault();
                closeMenu();
            }
        });
    };

    const clearGameInput = () => {
        if (typeof Input !== "undefined" && Input.clear) Input.clear();
        if (typeof TouchInput !== "undefined" && TouchInput.clear) TouchInput.clear();
    };

    const openMenu = () => {
        if (isOpen) return;
        if (!root) build();
        isOpen = true;
        clearGameInput();
        document.body.appendChild(root);
        render();
        timer = setInterval(updateLive, 200);
        searchBox.focus();
    };

    const closeMenu = () => {
        if (!isOpen) return;
        isOpen = false;
        clearInterval(timer);
        timer = null;
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        root.remove();
        clearGameInput();
    };

    document.addEventListener("keydown", (e) => {
        if (e.repeat || !isHotkey(e) || isField(e.target)) return;
        if (PLAYTEST_ONLY && !Utils.isOptionValid("test")) return;
        e.preventDefault();
        if (isOpen) closeMenu(); else openMenu();
    });
})();
