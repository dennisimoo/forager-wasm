using UndertaleModLib.Compiler;
EnsureDataLoaded();
var group = new CodeImportGroup(Data);
foreach(var obj in new[] {Data.GameObjects.ByName("objGame"),Data.GameObjects.ByName("objSkillGridControl")}) {
 foreach(var events in obj.Events) foreach(var ev in events) foreach(var action in ev.Actions) {
  if(action.CodeId != null && !action.CodeId.Name.Content.EndsWith("Mouse_60") && !action.CodeId.Name.Content.EndsWith("Mouse_61")) group.QueueReplace(action.CodeId.Name.Content, "");
 }
}
group.QueueReplace("gml_Object_InitController_Create_0", "var g=instance_create_depth(0,0,0,objGame); g.zoom=2; instance_create_depth(0,0,0,objSkillGridControl);");
group.Import();
