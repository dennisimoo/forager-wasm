using UndertaleModLib.Compiler;
using System.Text.RegularExpressions;
EnsureDataLoaded();
var waterName = "gml_Script_WaterCollision";
var entityName = "gml_Script_EntityWaterCollision";
var water = GetDecompiledText(waterName);
var entity = GetDecompiledText(entityName);
if (water.Contains("round(") || !water.Contains("position_meeting(argument0, argument1, objBridge)"))
    throw new System.Exception("WaterCollision has changed; review before patching.");
var samples = new Regex(@"clamp\(([^;]+)\)");
if (entity.Contains("round(") || samples.Matches(entity).Count != 8)
    throw new System.Exception("EntityWaterCollision has changed; review before patching.");
// Terrain and position_meeting must query the same integer pixel.
water = "var _x = round(argument0);\nvar _y = round(argument1);\n" +
    water.Replace("argument0", "_x").Replace("argument1", "_y");
entity = samples.Replace(entity, "round(clamp($1))");
var group = new CodeImportGroup(Data);
group.QueueReplace(waterName, water);
group.QueueReplace(entityName, entity);
group.Import();
