using UndertaleModLib.Compiler;
EnsureDataLoaded();
var codeName = "gml_Object_LightControl_Other_4";
if (Data.Code.ByName(codeName) == null) throw new System.Exception("Forager lighting event is missing.");
var original = GetDecompiledText(codeName);
if (original.Contains("overlayAlpha")) throw new System.Exception("Room-start lighting code has changed; review before patching.");
var group = new CodeImportGroup(Data);
group.QueuePrepend(codeName, "overlayAlpha = 0;");
group.Import();
