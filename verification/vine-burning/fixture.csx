using UndertaleModLib.Compiler;
EnsureDataLoaded();
var group = new CodeImportGroup(Data);
// Keep the original wall Create/Step/collision and fireball collision handlers.
// Isolate world bookkeeping, projectile motion, explosion damage, and UI.
foreach (var evs in Data.GameObjects.ByName("objGame").Events)
    foreach (var ev in evs) foreach (var action in ev.Actions)
        if (action.CodeId != null) group.QueueReplace(action.CodeId.Name.Content, "");
group.QueueReplace("gml_Object_parSolid_Create_0", "water=0; freeze=0;");
group.QueueReplace("gml_Object_parSolid_CleanUp_0", "");
group.QueueReplace("gml_Object_objVinedWall_Destroy_0", "global.vinesDestroyed++;");
group.QueueReplace("gml_Object_objFireball_Step_0", "");
group.QueueReplace("gml_Object_objFireball_Step_1", "");
group.QueueReplace("gml_Object_objExplosion_Step_0", "");
group.QueueReplace("gml_Object_InitController_Create_0", @"
global.vinesDestroyed=0;
var observer=instance_create_depth(0,0,0,objGame);
observer.auditFrame=0;
global.wallA=instance_create_depth(320,240,0,objVinedWall);
var fireA=instance_create_depth(320,240,0,objFireball);
fireA.owner=id; fireA.speed=0;
// Reverse creation order as well as testing a separated, unlit wall.
var fireB=instance_create_depth(480,240,0,objFireball);
fireB.owner=id; fireB.speed=0;
global.wallB=instance_create_depth(480,240,0,objVinedWall);
global.wallMiss=instance_create_depth(640,240,0,objVinedWall);
");
group.QueueReplace("gml_Object_objGame_Step_2", @"
auditFrame++;
if (auditFrame == 1) {
    if (global.wallA.burn == 1 && global.wallB.burn == 1 && global.wallMiss.burn == 0)
        show_debug_message(""VINES ignition PASS"");
    else show_debug_message(""VINES ignition FAIL"");
}
if (auditFrame == room_speed*2+3) {
    if (!instance_exists(global.wallA) && !instance_exists(global.wallB)
        && instance_exists(global.wallMiss) && global.wallMiss.burn == 0
        && global.vinesDestroyed == 2)
        show_debug_message(""VINES countdown PASS"");
    else show_debug_message(""VINES countdown FAIL destroyed="" + string(global.vinesDestroyed));
    game_end();
}
");
group.Import();
