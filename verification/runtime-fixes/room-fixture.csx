using UndertaleModLib.Compiler;
EnsureDataLoaded();
Data.Rooms[0].Persistent = true;
var group = new CodeImportGroup(Data);
group.QueueReplace("gml_Object_InitController_Create_0", @"
var b=instance_create_depth(20,20,0,objBridge);
position_meeting(20,20,objBridge);
b.x=700; b.y=200;
room_goto(room);
");
group.QueueReplace("gml_Object_objBridge_Create_0", "");
group.QueueReplace("gml_Object_objBridge_Step_0", @"
if(position_meeting(700,200,objBridge)) show_debug_message(""AUDIT restored room collision PASS"");
else { show_debug_message(""AUDIT restored room collision FAIL""); }
game_end();
");
group.QueueReplace("gml_Object_objBridge_CleanUp_0", "");
group.QueueReplace("gml_Object_objBridge_Draw_0", "");
group.Import();
