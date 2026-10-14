sprite_index = sprPlayerIdle; mask_index = sprPlayerIdle;
for (var i = 0; i < 5; i++) {
    var ll = layer_create(0, "bridge_test" + string(i));
    global.tilemap[i] = layer_tilemap_create(ll, 0, 0, tilesGrasslands, 84, 84);
}
var b1 = instance_create_depth(696, 696, 0, objBridge);
var b2 = instance_create_depth(712, 696, 0, objBridge);
var failures = 0; var checks = 0;
for (var axis = 0; axis < 2; axis++) {
    for (var cx = 40; cx < 47; cx++) for (var cy = 40; cy < 47; cy++) {
        var land = axis == 0 ? (cx < 43 || cx > 44) : (cy < 43 || cy > 44);
        tilemap_set(global.tilemap[0], land ? 1 : 0, cx, cy);
    }
    b2.x = axis == 0 ? 712 : 696; b2.y = axis == 0 ? 696 : 712;
    for (var travelDir = -1; travelDir <= 1; travelDir += 2) {
        for (var fraction = 0; fraction < 1; fraction += 0.25) {
            for (var step = 0; step <= 48; step++) {
                var p = (travelDir == 1 ? 680 + step : 728 - step) + fraction;
                x = axis == 0 ? p : 696; y = axis == 0 ? 696 : p;
                checks++;
                if (WaterCollision(x, y) || TileCollision(x, y) || EntityWaterCollision(0, 0)) {
                    failures++;
                    show_debug_message("BRIDGE blocked axis=" + string(axis) + " travelDir=" + string(travelDir) + " p=" + string(p));
                }
            }
        }
    }
    // Adjacent open water must remain impassable for the point and entity checks.
    for (var fraction = 0; fraction < 1; fraction += 0.25) {
        x = axis == 0 ? 696 + fraction : 680;
        y = axis == 0 ? 680 : 696 + fraction;
        checks++;
        if (!WaterCollision(x, y) || !EntityWaterCollision(0, 0)) failures++;
    }
}
show_debug_message("BRIDGE checks=" + string(checks) + " failures=" + string(failures));
game_end();
