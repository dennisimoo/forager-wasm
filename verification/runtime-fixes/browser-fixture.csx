using UndertaleModLib.Compiler;
EnsureDataLoaded();
var group=new CodeImportGroup(Data);
group.QueueReplace("gml_Object_InitController_Create_0", @"
var b=instance_create_depth(0,0,0,objBridge);
var ps=part_system_create(); part_system_depth(ps,-10000);
var t=part_type_create(); part_type_shape(t,12);
part_type_size(t,2,2,0,0); part_type_alpha1(t,0.8); part_type_life(t,10000,10000);
part_particles_create(ps,320,240,t,1);
for(var i=0;i<3;i++) effect_create_above(7,520+i*100,240,i,c_white);
");
group.QueueReplace("gml_Object_objBridge_Create_0", "auditKey=0; auditMouse=0; auditFrame=0; auditReleased=0; auditMouseReleased=0;");
group.QueueReplace("gml_Object_objBridge_Step_0", @"
auditKey=keyboard_check(ord(""A"")); auditMouse=mouse_check_button(mb_left);
if(keyboard_check_released(ord(""A"")))auditReleased++;
if(mouse_check_button_released(mb_left))auditMouseReleased++;
auditFrame++;
if(auditFrame mod 90 == 0) { for(var i=0;i<3;i++)effect_create_above(7,520+i*100,240,i,c_white); }
");
group.QueueReplace("gml_Object_objBridge_Draw_0", "draw_clear(make_color_rgb(40,80,100));");
group.QueueReplace("gml_Object_objBridge_CleanUp_0", "");
group.Import();
