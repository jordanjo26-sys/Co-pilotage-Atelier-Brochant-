// Illustration vectorielle de remplacement : à remplacer par une vraie
// photographie qualitative (maison rénovée, isolation ou pose de pompe à
// chaleur) avant mise en production — cf. cahier des charges.
export function HouseIllustration() {
  return (
    <svg
      viewBox="0 0 480 380"
      className="h-auto w-full drop-shadow-sm"
      role="img"
      aria-label="Illustration d'une maison rénovée, basse consommation, avec panneaux solaires et pompe à chaleur"
    >
      <ellipse cx="240" cy="345" rx="190" ry="18" fill="#0a4f41" opacity="0.08" />

      {/* Soleil */}
      <circle cx="410" cy="70" r="34" fill="#f2a93b" opacity="0.9" />
      {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => (
        <line
          key={angle}
          x1={410 + Math.cos((angle * Math.PI) / 180) * 46}
          y1={70 + Math.sin((angle * Math.PI) / 180) * 46}
          x2={410 + Math.cos((angle * Math.PI) / 180) * 58}
          y2={70 + Math.sin((angle * Math.PI) / 180) * 58}
          stroke="#f2a93b"
          strokeWidth="4"
          strokeLinecap="round"
          opacity="0.7"
        />
      ))}

      {/* Corps de la maison */}
      <rect x="90" y="180" width="230" height="150" rx="6" fill="#ffffff" stroke="#0e6b57" strokeWidth="3" />
      {/* Toit */}
      <path d="M70 190 L205 100 L340 190 Z" fill="#0e6b57" />
      {/* Panneaux solaires sur le toit */}
      <g transform="translate(150 130) rotate(-27)">
        {[0, 1, 2].map((i) => (
          <rect
            key={i}
            x={i * 34}
            y="0"
            width="30"
            height="46"
            rx="2"
            fill="#1f2a24"
            stroke="#f2a93b"
            strokeWidth="2"
          />
        ))}
      </g>

      {/* Porte */}
      <rect x="185" y="255" width="46" height="75" rx="3" fill="#0a4f41" />
      {/* Fenêtres isolées (double vitrage) */}
      <rect x="115" y="210" width="46" height="40" rx="3" fill="#e6f2ee" stroke="#0e6b57" strokeWidth="2" />
      <rect x="255" y="210" width="46" height="40" rx="3" fill="#e6f2ee" stroke="#0e6b57" strokeWidth="2" />

      {/* Pompe à chaleur extérieure */}
      <g transform="translate(330 270)">
        <rect x="0" y="0" width="60" height="42" rx="6" fill="#ffffff" stroke="#0e6b57" strokeWidth="3" />
        <line x1="8" y1="10" x2="52" y2="10" stroke="#0e6b57" strokeWidth="2" />
        <line x1="8" y1="18" x2="52" y2="18" stroke="#0e6b57" strokeWidth="2" />
        <line x1="8" y1="26" x2="52" y2="26" stroke="#0e6b57" strokeWidth="2" />
        <line x1="8" y1="34" x2="52" y2="34" stroke="#0e6b57" strokeWidth="2" />
      </g>

      {/* Feuille (symbole énergie propre) */}
      <path
        d="M60 300c30-45 80-45 95-10-35 15-70 20-95 10Z"
        fill="#f2a93b"
        opacity="0.85"
      />
    </svg>
  );
}
