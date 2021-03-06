'use strict';

var DOM = require('../../util/dom'),
    util = require('../../util/util');

module.exports = TouchZoomRotate;

var inertiaLinearity = 0.15,
    inertiaEasing = util.bezier(0, 0, inertiaLinearity, 1),
    inertiaDeceleration = 12, // scale / s^2
    inertiaMaxSpeed = 2.5, // scale / s
    significantScaleThreshold = 0.15,
    significantRotateThreshold = 4;


function TouchZoomRotate(map) {
    this._map = map;
    this._el = map.getCanvasContainer();

    util.bindHandlers(this);
}

TouchZoomRotate.prototype = {
    enable: function () {
        this._el.addEventListener('touchstart', this._onStart, false);
    },

    disable: function () {
        this._el.removeEventListener('touchstart', this._onStart);
    },

    disableRotation: function() {
        this._rotationDisabled = true;
    },

    enableRotation: function() {
        this._rotationDisabled = false;
    },

    _onStart: function (e) {
        if (e.touches.length !== 2) return;

        var p0 = DOM.mousePos(this._el, e.touches[0]),
            p1 = DOM.mousePos(this._el, e.touches[1]);

        this._startVec = p0.sub(p1);
        this._startScale = this._map.transform.scale;
        this._startBearing = this._map.transform.bearing;
        this._gestureIntent = undefined;
        this._inertia = [];

        document.addEventListener('touchmove', this._onMove, false);
        document.addEventListener('touchend', this._onEnd, false);
    },

    _onMove: function (e) {
        if (e.touches.length !== 2) return;

        var p0 = DOM.mousePos(this._el, e.touches[0]),
            p1 = DOM.mousePos(this._el, e.touches[1]),
            p = p0.add(p1).div(2),
            vec = p0.sub(p1),
            scale = vec.mag() / this._startVec.mag(),
            bearing = this._rotationDisabled ? 0 : vec.angleWith(this._startVec) * 180 / Math.PI,
            map = this._map;

        // Determine 'intent' by whichever threshold is surpassed first,
        // then keep that state for the duration of this gesture.
        if (!this._gestureIntent) {
            var scalingSignificantly = (Math.abs(1 - scale) > significantScaleThreshold),
                rotatingSignificantly = (Math.abs(bearing) > significantRotateThreshold);

            if (rotatingSignificantly) {
                this._gestureIntent = 'rotate';
            } else if (scalingSignificantly) {
                this._gestureIntent = 'zoom';
            }

            if (this._gestureIntent) {
                this._startVec = vec;
                this._startScale = map.transform.scale;
                this._startBearing = map.transform.bearing;
            }

        } else {
            var param = { duration: 0, around: map.unproject(p) };

            if (this._gestureIntent === 'rotate') {
                param.bearing = this._startBearing + bearing;
            }
            if (this._gestureIntent === 'zoom' || this._gestureIntent === 'rotate') {
                param.zoom = map.transform.scaleZoom(this._startScale * scale);
            }

            map.stop();
            this._drainInertiaBuffer();
            this._inertia.push([Date.now(), scale, p]);

            map.easeTo(param);
        }

        e.preventDefault();
    },

    _onEnd: function () {
        document.removeEventListener('touchmove', this._onMove);
        document.removeEventListener('touchend', this._onEnd);
        this._drainInertiaBuffer();

        var inertia = this._inertia,
            map = this._map;

        if (inertia.length < 2) {
            map.snapToNorth();
            return;
        }

        var last = inertia[inertia.length - 1],
            first = inertia[0],
            lastScale = map.transform.scaleZoom(this._startScale * last[1]),
            firstScale = map.transform.scaleZoom(this._startScale * first[1]),
            scaleOffset = lastScale - firstScale,
            scaleDuration = (last[0] - first[0]) / 1000,
            p = last[2];

        if (scaleDuration === 0 || lastScale === firstScale) {
            map.snapToNorth();
            return;
        }

        // calculate scale/s speed and adjust for increased initial animation speed when easing
        var speed = scaleOffset * inertiaLinearity / scaleDuration; // scale/s

        if (Math.abs(speed) > inertiaMaxSpeed) {
            if (speed > 0) {
                speed = inertiaMaxSpeed;
            } else {
                speed = -inertiaMaxSpeed;
            }
        }

        var duration = Math.abs(speed / (inertiaDeceleration * inertiaLinearity)) * 1000,
            targetScale = lastScale + speed * duration / 2000;

        if (targetScale < 0) {
            targetScale = 0;
        }

        map.easeTo({
            zoom: targetScale,
            duration: duration,
            easing: inertiaEasing,
            around: map.unproject(p)
        });
    },

    _drainInertiaBuffer: function() {
        var inertia = this._inertia,
            now = Date.now(),
            cutoff = 160; // msec

        while (inertia.length > 2 && now - inertia[0][0] > cutoff) inertia.shift();
    }
};
