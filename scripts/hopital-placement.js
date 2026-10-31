// PLACEMENT HOPITAL - position du patient selon le cas (au lit, assis, bord du lit...)
// Source : PROMPT-OPTIMISE-CLAUDE-HOPITAL-FINAL

const HOSPITAL_POSITIONS = {
  inconscient: { image: "inconscient-allonge-lit.webp", lit_angle: 0, label: "Lit 0° - Critique", desc: "Allongé, yeux fermés" },
  "douleur-thoracique": { image: "adulte-40-douleur-thoracique-assis-lit.webp", lit_angle: 45, label: "Lit 45° - Urgent", desc: "Assis main poitrine" },
  fievre: { image: "enfant-08-fievre-allonge-lit.webp", lit_angle: 30, label: "Lit 30° - Fièvre", desc: "Allongé thermomètre" },
  "douleur-abdo": { image: "ado-15-douleur-abdo-recroqueville-lit.webp", lit_angle: 20, label: "Lit 20° - Urgent", desc: "Recroquevillé" },
  anxiete: { image: "adulte-30-anxiete-assis-bord-lit.webp", lit_angle: 90, label: "Bord du lit - Léger", desc: "Assise bord lit" },
  confusion: { image: "senior-75-confusion-allonge-oxygene.webp", lit_angle: 40, label: "Lit 40° O2 - Urgent", desc: "Allongé O2" }
};

function getHospitalPlacement(diagnostic, conscience, age) {
  const d = (diagnostic || "").toLowerCase();
  if (conscience == "inconscient" || d.includes("inconscient") || d.includes("coma")) return HOSPITAL_POSITIONS.inconscient;
  if (d.includes("thorac") || d.includes("infarctus") || d.includes("idm")) return HOSPITAL_POSITIONS["douleur-thoracique"];
  if (d.includes("fievre") || d.includes("paludisme")) return HOSPITAL_POSITIONS.fievre;
  if (d.includes("abdo") || d.includes("appendicite") || d.includes("peritonite")) return HOSPITAL_POSITIONS["douleur-abdo"];
  if (d.includes("anx") || d.includes("panique")) return HOSPITAL_POSITIONS.anxiete;
  if (d.includes("confus") || d.includes("avc") || d.includes("desorient")) return HOSPITAL_POSITIONS.confusion;
  if (age < 12) return HOSPITAL_POSITIONS.fievre;
  if (age >= 60) return HOSPITAL_POSITIONS.confusion;
  return HOSPITAL_POSITIONS["douleur-thoracique"];
}

// Libellé affiché dans la modale : "📍 Placement : Lit 0° - Critique"
function placementLabel(placement) {
  return placement ? "📍 Placement : " + placement.label + " (" + placement.desc + ")" : "";
}
