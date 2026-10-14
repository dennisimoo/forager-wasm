#include "runner.h"
#include "vm_builtins.h"
#include "gml_array.h"
#include "collision.h"
#include <assert.h>
#include <stdio.h>

void platformLog(const logType type, const char* format, va_list args) {
    (void)type;
    vfprintf(stdout, format, args);
}

static RValue call(VMContext* ctx, const char* name, RValue* args, int count) {
    BuiltinFunc fn = VM_findBuiltin(ctx, name);
    assert(fn != NULL);
    return fn(ctx, args, count);
}
int main(void) {
    DataWin data = {0};
    data.gen8.wadVersion = 17;
    data.detectedFormat.major = 2;
    data.detectedFormat.minor = 2;
    VMContext* ctx = VM_create(&data);
    Runner runner = {0};
    runner.dataWin = &data;
    runner.vmContext = ctx;
    ctx->runner = &runner;
    runner.gameSpeedOverride = 60;
    RValue id = call(ctx, "ds_list_create", NULL, 0);
    GMLArray* array = GMLArray_create(&data, 15);
    RValue add[] = {id, RValue_makeArrayWeak(array)};
    call(ctx, "ds_list_add", add, 2);
    assert(array->refCount == 2);
    RValue del[] = {id, RValue_makeReal(0)};
    call(ctx, "ds_list_delete", del, 2);
    assert(array->refCount == 1); // failed before the fix
    call(ctx, "ds_list_destroy", &id, 1);
    GMLArray_decRef(array);
    arrfree(runner.dsListPool);
    puts("PASS: deleting a list array releases its reference");

    Sprite sprite = {0};
    sprite.width = sprite.height = 16;
    sprite.bboxMode = 1;
    data.sprt.sprites = &sprite;
    data.sprt.count = 1;
    Instance instance = {0};
    instance.instanceId = 100001;
    instance.maskIndex = -1;
    instance.active = true;
    instance.imageXscale = instance.imageYscale = 1;
    runner.spatialGrid = SpatialGrid_create(1344, 1344);
    hmput(runner.instancesById, instance.instanceId, &instance);
    SpatialGrid_markInstanceAsDirty(runner.spatialGrid, &instance);
    SpatialGrid_syncGrid(&runner, runner.spatialGrid);
    assert(arrlen(instance.collisionCells) == 1);
    instance.x = 130;
    SpatialGrid_markInstanceAsDirty(runner.spatialGrid, &instance);
    SpatialGrid_syncGrid(&runner, runner.spatialGrid);
    assert(arrlen(runner.spatialGrid->grid[0]) == 0);
    assert(arrlen(runner.spatialGrid->grid[2]) == 1);
    instance.active = false;
    SpatialGrid_markInstanceAsDirty(runner.spatialGrid, &instance);
    assert(arrlen(runner.spatialGrid->grid[2]) == 0);
    instance.active = true;
    SpatialGrid_markInstanceAsDirty(runner.spatialGrid, &instance);
    SpatialGrid_syncGrid(&runner, runner.spatialGrid);
    assert(arrlen(runner.spatialGrid->grid[2]) == 1);
    instance.destroyed = true;
    SpatialGrid_markInstanceAsDirty(runner.spatialGrid, &instance);
    assert(arrlen(runner.spatialGrid->grid[2]) == 0);
    SpatialGrid_free(runner.spatialGrid);
    arrfree(instance.collisionCells);
    hmfree(runner.instancesById);
    puts("PASS: collision membership follows movement, activation, and destruction");

    RValue typeId = call(ctx, "part_type_create", NULL, 0);
    RValue shape[] = {typeId, RValue_makeReal(12)};
    call(ctx, "part_type_shape", shape, 2);
    assert(runner.particleTypePool[RValue_toInt32(typeId)].shape == 12);
    for (int size = 0; size < 3; size++) {
        RValue effect[] = {RValue_makeReal(7), RValue_makeReal(100), RValue_makeReal(100), RValue_makeReal(size), RValue_makeReal(0xffffff)};
        for (int n = 0; n < 100; n++) call(ctx, "effect_create_above", effect, 5);
    }
    assert(arrlen(runner.particleTypePool) == 4);
    assert(arrlen(runner.particleSystemPool) == 1);
    assert(arrlen(runner.particleSystemPool[0].particles) == 300);
    for (int frame = 0; frame < 61; frame++) Particles_updateAutomatic(&runner);
    assert(arrlen(runner.particleSystemPool[0].particles) == 0);
    Particles_freeAll(&runner);
    VM_free(ctx);
    puts("PASS: smoke shape and all sparkle sizes register; particles expire and reuse pools");
}
