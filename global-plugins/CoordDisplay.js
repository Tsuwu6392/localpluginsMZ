//=============================================================================
// CoordDisplay.js
//=============================================================================

/*:
 * @target MZ
 * @plugindesc Shows map name and player coordinates in the top-right corner.
 * @author Claude
 *
 * @param fontSize
 * @text Font Size
 * @type number
 * @min 8
 * @default 18
 *
 * @param textColor
 * @text Text Color
 * @desc CSS color string.
 * @default #ffffff
 *
 * @param xDecimals
 * @text X Decimals
 * @type number
 * @min 0
 * @max 3
 * @default 1
 *
 * @param yDecimals
 * @text Y Decimals
 * @type number
 * @min 0
 * @max 3
 * @default 0
 *
 * @param shadowColor
 * @text Shadow Color
 * @desc CSS color string for the drop shadow, keeps text legible over any background. Set alpha to 0 to disable.
 * @default rgba(0,0,0,0.6)
 *
 * @param padding
 * @text Corner Padding
 * @type number
 * @min 0
 * @default 8
 *
 * @param position
 * @text Screen Position
 * @desc Where to anchor the display: any corner or the middle of any edge.
 * @type select
 * @option Top Left
 * @value topLeft
 * @option Top Center
 * @value topCenter
 * @option Top Right
 * @value topRight
 * @option Middle Left
 * @value middleLeft
 * @option Middle Right
 * @value middleRight
 * @option Bottom Left
 * @value bottomLeft
 * @option Bottom Center
 * @value bottomCenter
 * @option Bottom Right
 * @value bottomRight
 * @default topRight
 *
 * @help CoordDisplay.js
 *
 * Displays "MapName - X;Y" anchored at a corner or edge-midpoint of the
 * map screen (configurable via the Screen Position parameter).
 * X and Y decimal precision are configurable separately (player position
 * is fractional while moving).
 *
 * While a message window is open, the display shifts to the middle of
 * the same side (left stays left, right/center becomes right) so it
 * never overlaps the message box, then returns to its normal position
 * once the message closes.
 *
 * No plugin commands. Just add to the plugin list and turn it on.
 */

(() => {
    "use strict";

    const pluginName = "CoordDisplay";
    const params = PluginManager.parameters(pluginName);
    const fontSize = Number(params.fontSize || 18);
    const textColor = String(params.textColor || "#ffffff");
    const shadowColor = String(params.shadowColor || "rgba(0,0,0,0.6)");
    const xDecimals = Number(params.xDecimals || 1);
    const yDecimals = Number(params.yDecimals || 0);
    const padding = Number(params.padding || 8);
    const position = String(params.position || "topRight");

    // Maps each of the 8 anchor points to a horizontal/vertical zone and
    // the text alignment that reads naturally from that zone.
    const POSITION_LAYOUT = {
        topLeft: { h: "left", v: "top", align: "left" },
        topCenter: { h: "center", v: "top", align: "center" },
        topRight: { h: "right", v: "top", align: "right" },
        middleLeft: { h: "left", v: "middle", align: "left" },
        middleRight: { h: "right", v: "middle", align: "right" },
        bottomLeft: { h: "left", v: "bottom", align: "left" },
        bottomCenter: { h: "center", v: "bottom", align: "center" },
        bottomRight: { h: "right", v: "bottom", align: "right" }
    };

    function getLayout() {
        return POSITION_LAYOUT[position] || POSITION_LAYOUT.topRight;
    }

    // Same horizontal side as the configured position, but vertically
    // centered - used while a message window is open so the two never
    // overlap. Center-anchored positions fall back to the right side.
    function getMessageLayout() {
        const base = getLayout();
        return base.h === "left" ? POSITION_LAYOUT.middleLeft : POSITION_LAYOUT.middleRight;
    }

    function computeRect(width, height, layout) {
        let x;
        if (layout.h === "left") {
            x = padding;
        } else if (layout.h === "center") {
            x = Math.round((Graphics.boxWidth - width) / 2);
        } else {
            x = Graphics.boxWidth - width - padding;
        }

        let y;
        if (layout.v === "top") {
            y = padding;
        } else if (layout.v === "middle") {
            y = Math.round((Graphics.boxHeight - height) / 2);
        } else {
            y = Graphics.boxHeight - height - padding;
        }

        return new Rectangle(x, y, width, height);
    }

    class Window_CoordDisplay extends Window_Base {
        constructor() {
            const width = 240;
            const height = fontSize + padding * 2 + 8;
            const layout = getLayout();
            super(computeRect(width, height, layout));
            this._width = width;
            this._height = height;
            this._normalLayout = layout;
            this._messageLayout = getMessageLayout();
            this._messageActive = false;
            this.opacity = 0;
            this.contentsOpacity = 255;
            this.refresh();
        }

        updatePadding() {
            this.padding = 4;
        }

        refresh() {
            this.contents.clear();
            this.contents.fontSize = fontSize;
            this.contents.fontBold = true;

            const mapId = $gameMap.mapId();
            const x = $gamePlayer.x.toFixed(xDecimals);
            const y = $gamePlayer.y.toFixed(yDecimals);
            const text = `${mapId} - ${x};${y}`;
            const align = (this._messageActive ? this._messageLayout : this._normalLayout).align;
            const width = this.contents.width;

            // Shadow pass first (offset by 1px), then the main text on top.
            // Keeps the text legible over any background it happens to sit on.
            this.contents.textColor = shadowColor;
            this.drawText(text, 1, 1, width, align);

            this.contents.textColor = textColor;
            this.drawText(text, 0, 0, width, align);
        }

        update() {
            super.update();

            const busy = $gameMessage.isBusy();
            if (busy !== this._messageActive) {
                this._messageActive = busy;
                const layout = busy ? this._messageLayout : this._normalLayout;
                const rect = computeRect(this._width, this._height, layout);
                this.move(rect.x, rect.y, rect.width, rect.height);
                this.refresh();
            }

            this._lastX = this._lastX ?? null;
            this._lastY = this._lastY ?? null;
            this._lastMap = this._lastMap ?? null;

            const curX = $gamePlayer.x.toFixed(xDecimals);
            const curY = $gamePlayer.y.toFixed(yDecimals);
            const curMap = $gameMap.mapId();

            if (curX !== this._lastX || curY !== this._lastY || curMap !== this._lastMap) {
                this._lastX = curX;
                this._lastY = curY;
                this._lastMap = curMap;
                this.refresh();
            }
        }
    }

    const _Scene_Map_createAllWindows = Scene_Map.prototype.createAllWindows;
    Scene_Map.prototype.createAllWindows = function () {
        _Scene_Map_createAllWindows.call(this);
        this._coordDisplayWindow = new Window_CoordDisplay();
        this.addWindow(this._coordDisplayWindow);
    };
})();
