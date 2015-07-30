'use strict';

var FeatureTree = require('../data/feature_tree');
var CollisionTile = require('../symbol/collision_tile');
var BufferSet = require('../data/buffer/buffer_set');
var createBucket = require('../data/create_bucket');
var StyleDeclarationSet = require('../style/style_declaration_set');
var featureFilter = require('feature-filter');

module.exports = WorkerTile;

function WorkerTile(params) {
    this.coord = params.coord;
    this.uid = params.uid;
    this.zoom = params.zoom;
    this.maxZoom = params.maxZoom;
    this.tileSize = params.tileSize;
    this.source = params.source;
    this.overscaling = params.overscaling;
    this.angle = params.angle;
    this.pitch = params.pitch;
    this.collisionDebug = params.collisionDebug;
    this.devicePixelRatio = params.devicePixelRatio;

    this.stacks = {};
}

WorkerTile.prototype.parse = function(data, layers, constants, actor, callback) {

    this.status = 'parsing';

    this.featureTree = new FeatureTree(this.coord, this.overscaling);

    var i, k,
        tile = this,
        layer,
        buffers = new BufferSet(),
        collisionTile = new CollisionTile(this.angle, this.pitch),
        buckets = this.buckets = {},
        bucketsInOrder = this.bucketsInOrder = [],
        bucketsBySourceLayer = {},
        bucketFilters = {};

    // Map non-ref layers to buckets.
    for (i = 0; i < layers.length; i++) {
        layer = layers[i];

        if (layer.source !== this.source)
            continue;

        if (layer.ref)
            continue;

        var minzoom = layer.minzoom;
        if (minzoom && this.zoom < minzoom && minzoom < this.maxZoom)
            continue;

        var maxzoom = layer.maxzoom;
        if (maxzoom && this.zoom >= maxzoom)
            continue;

        var visibility = layer.layout.visibility;
        if (visibility === 'none')
            continue;

        var filter = featureFilter(layer.filter);

        var bucketLayers = [layer];
        if (layers) {
            for (var j = 0; j < layers.length; j++) {
                if (layers[j].ref === layer.id) {
                    bucketLayers.push(layers[j]);
                }
            }
        }

        var bucket = createBucket({
            id: layer.id,
            layer: layer,
            layers: bucketLayers,
            buffers: buffers,
            constants: constants,
            zoom: this.zoom,
            z: this.zoom,
            overscaling: this.overscaling,
            collisionDebug: this.collisionDebug,
            devicePixelRatio: this.devicePixelRatio,
            filter: filter,
            isInteractive: layer.interactive,
            tileSource: this.source,
            tileUid: this.uid
        });

        bucketFilters[bucket.id] = filter;
        buckets[bucket.id] = bucket;
        bucketsInOrder.push(bucket);

        if (data.layers) {
            // vectortile
            var sourceLayer = layer['source-layer'];
            if (!bucketsBySourceLayer[sourceLayer])
                bucketsBySourceLayer[sourceLayer] = {};
            bucketsBySourceLayer[sourceLayer][bucket.id] = bucket;
        } else {
            // geojson tile
            bucketsBySourceLayer[bucket.id] = bucket;
        }
    }

    // Index ref layers.
    for (i = 0; i < layers.length; i++) {
        layer = layers[i];

        if (layer.source !== this.source)
            continue;

        bucket = buckets[layer.ref || layer.id];
        if (!bucket)
            continue;

        if (!bucket.isMapboxBucket) {
            bucket.layers.push(layer.id);
            bucket.layerPaintDeclarations[layer.id] =
                new StyleDeclarationSet('paint', layer.type, layer.paint, constants).values();
        }
    }

    var extent = 4096;

    // read each layer, and sort its features into buckets
    if (data.layers) {
        // vectortile
        for (k in bucketsBySourceLayer) {
            layer = data.layers[k];
            if (!layer) continue;
            if (layer.extent) extent = layer.extent;
            sortLayerIntoBuckets(layer, bucketsBySourceLayer[k]);
        }
    } else {
        // geojson
        sortLayerIntoBuckets(data, bucketsBySourceLayer);
    }

    function sortLayerIntoBuckets(layer, buckets) {
        for (var i = 0; i < layer.length; i++) {
            var feature = layer.feature(i);
            for (var key in buckets) {
                var bucket = buckets[key];
                if (bucketFilters[bucket.id](feature)) {
                    bucket.features.push(feature);
                }
            }
        }
    }

    var prevPlacementBucket;
    var remaining = bucketsInOrder.length;

    /*
     *  The async parsing here is a bit tricky.
     *  Some buckets depend on resources that may need to be loaded async (glyphs).
     *  Some buckets need to be parsed in order (to get collision priorities right).
     *
     *  Dependencies calls are initiated first to get those rolling.
     *  Buckets that don't need to be parsed in order, aren't to save time.
     */

    for (i = 0; i < bucketsInOrder.length; i++) {
        bucket = bucketsInOrder[i];

        // Link buckets that need to be parsed in order
        if (bucket.needsPlacement) {
            if (prevPlacementBucket) {
                prevPlacementBucket.next = bucket;
            } else {
                bucket.previousPlaced = true;
            }
            prevPlacementBucket = bucket;
        }

        if (bucket.getDependencies) {
            bucket.getDependencies(this, actor, dependenciesDone(bucket));
        }

        // immediately parse buckets where order doesn't matter and no dependencies
        if (!bucket.needsPlacement && !bucket.getDependencies) {
            parseBucket(tile, bucket);
        }
    }

    function dependenciesDone(bucket) {
        return function(err) {
            bucket.dependenciesLoaded = true;
            parseBucket(tile, bucket, err);
        };
    }

    function parseBucket(tile, bucket, skip) {
        if (bucket.getDependencies && !bucket.dependenciesLoaded) return;
        if (bucket.needsPlacement && !bucket.previousPlaced) return;

        if (!skip) {

            var timeStart = Date.now();

            if (!bucket.isMapboxBucket) {
                if (bucket.features.length) {
                    bucket.addFeatures(collisionTile);
                }
            } else {
                bucket.updateBuffers();
            }

            var timeElapsed = Date.now() - timeStart;

            if (bucket.interactive) {
                for (var i = 0; i < bucket.features.length; i++) {
                    var feature = bucket.features[i];
                    tile.featureTree.insert(feature.bbox(), bucket.layers, feature);
                }
            }
            if (typeof self !== 'undefined') {
                self.bucketStats = self.bucketStats || {_total: 0};
                self.bucketStats._total += timeElapsed;
                self.bucketStats[bucket.id] = (self.bucketStats[bucket.id] || 0) + timeElapsed;
            }

        }

        remaining--;

        if (!remaining) {
            done();
            return;
        }

        // try parsing the next bucket, if it is ready
        if (bucket.next) {
            bucket.next.previousPlaced = true;
            parseBucket(tile, bucket.next);
        }
    }

    function done() {

        tile.status = 'done';

        if (tile.redoPlacementAfterDone) {
            var result = tile.redoPlacement(tile.angle, tile.pitch).result;
            buffers.glyphVertex = result.buffers.glyphVertex;
            buffers.iconVertex = result.buffers.iconVertex;
            buffers.collisionBoxVertex = result.buffers.collisionBoxVertex;
        }

        var elementGroups = {};

        var serializedBuffers = {};
        var serializedBuckets = {};
        var transferrables = [];

        for (k in buckets) {
            var bucket = buckets[k];
            elementGroups[k] = bucket.elementGroups;
            if (bucket.isMapboxBucket) {
                serializedBuckets[k] = bucket.serialize();
                transferrables = transferrables.concat(bucket.getTransferrables());
            }
        }

        for (var j in buffers) {
            var buffer = buffers[j];
            serializedBuffers[j] = buffer.serialize();
            transferrables = transferrables.concat(buffer.getTransferrables());
        }

        callback(null, {
            buffers: serializedBuffers,
            buckets: serializedBuckets,
            elementGroups: elementGroups, // TODO Is this duplicate?
            extent: extent
        }, transferrables);
    }
};

WorkerTile.prototype.redoPlacement = function(angle, pitch, collisionDebug) {

    if (this.status !== 'done') {
        this.redoPlacementAfterDone = true;
        this.angle = angle;
        return {};
    }

    var buffers = new BufferSet();
    var elementGroups = {};
    var collisionTile = new CollisionTile(angle, pitch);
    var serializedBuckets = {};

    var bucketsInOrder = this.bucketsInOrder;
    for (var i = 0; i < bucketsInOrder.length; i++) {
        var bucket = bucketsInOrder[i];

        if (bucket.type === 'symbol') {
            bucket.placeFeatures(collisionTile, buffers, collisionDebug);
            elementGroups[bucket.id] = bucket.elementGroups;
        }

        if (bucket.isMapboxBucket) {
            serializedBuckets[bucket.id] = bucket.serialize();
        }
    }

    var serializedBuffers = serializeBuffers(buffers);

    return {
        result: {
            elementGroups: elementGroups,
            buffers: serializedBuffers.buffers,
            buckets: serializedBuckets
        },
        transferrables: serializedBuffers.transferrables
    };

};

function serializeBuffers(buffers) {
    // TODO after transferring a buffer, we lose ownership of the object. Make sure this is
    // enforced.
    var transferrables = [];
    var serializedBuffers = {};

    for (var bufferName in buffers) {
        var buffer = buffers[bufferName];
        serializedBuffers[bufferName] = buffer.serialize();
        transferrables.push(buffer.array || buffer.arrayBuffer);
    }

    return {
        transferrables: transferrables,
        buffers: serializedBuffers
    };
}
