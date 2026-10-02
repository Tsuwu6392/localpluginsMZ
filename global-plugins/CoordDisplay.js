//=============================================================================
// CoordDisplay.js
//=============================================================================

/*:
 * @target MZ
 * @plugindesc Shows the map name/id and player coordinates, anchored to a screen corner or edge.
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
 * @param mapLabel
 * @text Map Label
 * @desc What to show in front of the coordinates.
 * @type select
 * @option Map Name
 * @value name
 * @option Map ID
 * @value id
 * @default name
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
 * The window is inserted at the bottom of the scene's window layer, so the
 * message window, map name window and scroll text all draw on top of it.
 *
 * No plugin commands. Just add to the plugin list and turn it on.
 */

(() => {
    "use strict";

    const pluginName = "CoordDisplay";
    const params = PluginManager.parameters(pluginName);
    const fontSize     = Number(params.fontSize || 18);
    const textColor    = String(params.textColor || "#ffffff");
    const shadowColor  = String(params.shadowColor || "rgba(0,0,0,0.6)");
    const mapLabelMode = String(params.mapLabel || "name");
    const xDecimals    = Number(params.xDecimals || 1);
    const yDecimals    = Number(params.yDecimals || 0);
    const padding      = Number(params.padding || 8);
    const position     = String(params.position || "topRight");

    // Maps each of the 8 anchor points to a horizontal/vertical zone and
    // the text alignment that reads naturally from that zone.
    const POSITION_LAYOUT = {
        topLeft:      { h: "left",   v: "top",    align: "left"   },
        topCenter:    { h: "center", v: "top",    align: "center" },
        topRight:     { h: "right",  v: "top",    align: "right"  },
        middleLeft:   { h: "left",   v: "middle", align: "left"   },
        middleRight:  { h: "right",  v: "middle", align: "right"  },
        bottomLeft:   { h: "left",   v: "bottom", align: "left"   },
        bottomCenter: { h: "center", v: "bottom", align: "center" },
        bottomRight:  { h: "right",  v: "bottom", align: "right"  }
    };

    function getLayout() {
        return POSITION_LAYOUT[position] || POSITION_LAYOUT.topRight;
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

    function currentMapLabel() {
        if (mapLabelMode === "id") {
            return String($gameMap.mapId());
        }
        const name = $dataMap ? $dataMap.name : "";
        return name || String($gameMap.mapId());
    }

    class Window_CoordDisplay extends Window_Base {
        constructor() {
            const width = 240;
            const height = fontSize + padding * 2 + 8;
            super(new Rectangle(0, 0, width, height));

            this._layout = getLayout();
            this._lastText = null;
            this._lastBoxWidth = Graphics.boxWidth;
            this._lastBoxHeight = Graphics.boxHeight;

            this.opacity = 0;
            this.contentsOpacity = 255;
            this.reposition();
            this.refresh();
        }

        updatePadding() {
            this.padding = 4;
        }

        buildText() {
            const x = $gamePlayer.x.toFixed(xDecimals);
            const y = $gamePlayer.y.toFixed(yDecimals);
            return `${currentMapLabel()} - ${x};${y}`;
        }

        // Re-anchors the window for the current layout / screen size.
        reposition() {
            const rect = computeRect(this.width, this.height, this._layout);
            this.move(rect.x, rect.y, rect.width, rect.height);
        }

        refresh() {
            const text = this.buildText();
            this._lastText = text;

            this.contents.clear();
            this.contents.fontSize = fontSize;
            this.contents.fontBold = true;

            const align = this._layout.align;
            const width = this.contents.width;

            // Shadow pass first (offset by 1px), then the main text on top.
            // Keeps the text legible over any background it happens to sit on.
            // The shadow box is inset by 1px so the offset copy is not clipped
            // at the right/bottom edge of the contents bitmap.
            if (shadowColor && shadowColor !== "none") {
                this.contents.textColor = shadowColor;
                this.drawText(text, 1, 1, width - 1, align);
            }

            this.contents.textColor = textColor;
            this.drawText(text, 0, 0, width, align);
        }

        update() {
            super.update();

            // Re-anchor if the game resolution changed at runtime.
            if (Graphics.boxWidth !== this._lastBoxWidth ||
                Graphics.boxHeight !== this._lastBoxHeight) {
                this._lastBoxWidth = Graphics.boxWidth;
                this._lastBoxHeight = Graphics.boxHeight;
                this.reposition();
            }

            const text = this.buildText();
            if (text !== this._lastText) {
                this.refresh();
            }
        }
    }

    const _Scene_Map_createAllWindows = Scene_Map.prototype.createAllWindows;
    Scene_Map.prototype.createAllWindows = function () {
        _Scene_Map_createAllWindows.call(this);

        const window = new Window_CoordDisplay();
        this._coordDisplayWindow = window;

        // Insert at the very bottom of the window layer instead of using
        // addWindow(): everything else added to the map (message window,
        // map name window, scroll text...) then draws on top of this one.
        this._windowLayer.addChildAt(window, 0);
    };
})();