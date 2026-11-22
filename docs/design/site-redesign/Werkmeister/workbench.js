/* An orthographic assembly drawing. All dimensions below use the model's own units. */
(() => {
  "use strict";

  function mount() {
    const canvas = document.getElementById("workbench-art");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = 540, H = 390;
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const ink = "#292c29";
    const pale = "#f3f1e9";
    let openness = 1;
    let destination = 1;
    let frame = 0;
    let originY = 0;
    let narrow = false;

    function point(x, y, z) {
      return [242 + 1.04 * x - 0.84 * y, originY + 0.443 * x + 0.544 * y - z];
    }

    function outline(points, close = true) {
      ctx.beginPath();
      ctx.moveTo(...points[0]);
      for (let i = 1; i < points.length; i++) ctx.lineTo(...points[i]);
      if (close) ctx.closePath();
    }

    function shape(points, fill, stroke, width = 0.8) {
      outline(points);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
    }

    function line(points, color, width = 1) {
      outline(points, false);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    }

    function gradient(x1, y1, x2, y2, stops) {
      const grad = ctx.createLinearGradient(x1, y1, x2, y2);
      for (const [position, color] of stops) grad.addColorStop(position, color);
      return grad;
    }

    function beveled(x, y, w, h, corner = 4) {
      return [
        [x + corner, y], [x + w - corner, y], [x + w, y + corner],
        [x + w, y + h - corner], [x + w - corner, y + h], [x + corner, y + h],
        [x, y + h - corner], [x, y + corner],
      ];
    }

    function slab(plan, bottom, height, material) {
      const top = bottom + height;
      for (let i = 0; i < plan.length; i++) {
        const a = plan[i], b = plan[(i + 1) % plan.length];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        if (dy * 0.85 - dx <= 0) continue;
        const sideColor = dy < Math.abs(dx) * 0.3 ? material.front : dx > -Math.abs(dy) * 0.3 ? material.side : material.bevel;
        shape([point(...a, top), point(...b, top), point(...b, bottom), point(...a, bottom)], sideColor, material.edge, 0.65);
      }
      shape(plan.map(([x,y]) => point(x, y, top)), material.top, material.edge, 0.8);
    }

    function onTop(z, draw) {
      ctx.save();
      ctx.transform(1.04, 0.443, -0.84, 0.544, ...point(0, 0, z));
      draw();
      ctx.restore();
    }

    function frontFace(y, z, draw) {
      ctx.save();
      ctx.transform(1.04, 0.443, 0, 1, ...point(0, y, z));
      draw();
      ctx.restore();
    }

    function rightFace(x, y, z, draw) {
      ctx.save();
      ctx.transform(0.84, -0.544, 0, 1, ...point(x, y, z));
      draw();
      ctx.restore();
    }

    function dot(x, y, r, fill, stroke, width = 1) {
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke(); }
    }

    function bolt(x, y, radius = 2.6, dark = false) {
      dot(x, y, radius + 0.7, dark ? "#33332e" : "#5f6158");
      dot(x, y - 0.35, radius, dark ? "#696a61" : "#d9d7c9", dark ? "#20221f" : "#84867a", 0.65);
      line([[x - radius * 0.55, y + 0.5], [x + radius * 0.55, y - 0.5]], dark ? "#242722" : "#50554b", 0.9);
    }

    function topBolts(x, y, dark) {
      for (const px of [-x, x]) for (const py of [-y, y]) bolt(px, py, 2.5, dark);
    }

    function softShadow(x, y, rx, ry, opacity) {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(rx, ry);
      const shadow = ctx.createRadialGradient(0, 0, 0.02, 0, 0, 1);
      shadow.addColorStop(0, "rgba(38,39,31," + opacity + ")");
      shadow.addColorStop(0.48, "rgba(38,39,31," + opacity * 0.65 + ")");
      shadow.addColorStop(1, "rgba(38,39,31,0)");
      ctx.fillStyle = shadow;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
    }

    const darkMetal = { top:"#52564e", front:"#373a34", side:"#272b26", bevel:"#42453d", edge:"#252823" };
    const board = beveled(-108, -71, 216, 142, 8);
    const body = beveled(-105, -69, 210, 138, 7);
    const inner = beveled(-99, -63, 198, 126, 8);

    function base() {
      for (const [x, y] of [[-82,-49],[80,-49],[-82,49],[80,49]]) {
        slab(beveled(x - 11, y - 8, 22, 16, 4), -1, 7, darkMetal);
      }
      slab(body, 5, 3, darkMetal);
      const shell = {
        top:gradient(120, 235, 310, 329, [[0,"#f6f4e8"],[0.62,"#dcdcca"],[1,"#c9cbbd"]]),
        front:"#c7c7b7", side:"#9e9e90", bevel:"#b7b9aa", edge:"#73766b"
      };
      slab(board, 8, 12, shell);
      frontFace(71, 20, () => {
        line([[-97,9],[97,9]], "#a5a799", 0.65);
        for (let x = -90; x <= -27; x += 4.7) {
          line([[x,3],[x,7.8]], "#828578", 1.2);
          line([[x+1.3,3],[x+1.3,7.8]], "#d9dacb", 0.8);
        }
        ctx.fillStyle = "#42473d"; ctx.fillRect(52, 3.2, 29, 3.8);
        for (const x of [46, 86]) dot(x, 5.1, 1.2, "#575b50");
      });
      rightFace(108, 71, 20, () => {
        for (let x = 23; x < 108; x += 6) {
          ctx.fillStyle = "#7f8275"; ctx.fillRect(x, 3, 2.1, 5.6);
        }
      });
      onTop(20.15, () => {
        shape(beveled(-91,-55,182,110,4),"#b5b9a5","#898e7c",0.8);
        shape(beveled(-87,-51,174,102,4),"#c3c7b3","#d7d9c8",0.7);
        for (let i=0; i<8; i++) {
          const y = -40 + i * 4.2;
          line([[-79,y],[-57+i,y],[-34+i,-17+i*4.2],[25,-17+i*4.2],[41, i*4.2], [76,i*4.2]],"#8c9582",0.9);
          dot(-79,y,1.35,"#737d6b");
          dot(76,i*4.2,1.1,"#75816e");
        }
        for (let i=0; i<6; i++) {
          line([[-65+i*4.6,44],[-65+i*4.6,34],[-44+i*4.6,13],[-24+i*4.6,13]],"#828a76",1);
          dot(-65+i*4.6,44,1.45,"#8c927b");
        }
        topBolts(99,61,false);
        for(let i=0; i<10; i++) {
          ctx.fillStyle = i%3 === 0 ? "#686f60" : "#8b917e";
          ctx.fillRect(19+i*5.4,39,2.6,6);
        }
      });
      slab(beveled(-23,-18,52,37,3),20.2,5.5,darkMetal);
      onTop(25.7, () => {
        line([[-15,4],[1,4],[9,-4],[19,-4]],"#c6c9ba",1.4);
        for(const [x,y] of [[-15,4],[0,4],[19,-4]]) dot(x,y,1.9,"#c6c9ba");
      });
    }

    function services(z) {
      slab(inner,z-2.6,3,darkMetal);
      const shell = {
        top:gradient(125,130,362,267,[[0,"#74786d"],[0.58,"#5a5f55"],[1,"#4b5048"]]),
        front:"#444941",side:"#30362f",bevel:"#3a4038",edge:"#262c26"
      };
      slab(body,z,15,shell);
      frontFace(69,z+15, () => {
        for(let x=-92;x<=24;x+=4.8) {
          ctx.fillStyle="#222820";ctx.fillRect(x,3,2.4,8.7);
          ctx.fillStyle="#63675c";ctx.fillRect(x+2.4,3,0.7,8.7);
        }
        for(let i=0;i<3;i++) {
          ctx.fillStyle="#252b23";ctx.fillRect(47+i*14,3.8,9.8,6.9);
          ctx.fillStyle="#a2a693";ctx.fillRect(47.6+i*14,4.4,8.6,1.15);
          ctx.fillStyle="#626b5d";ctx.fillRect(47.6+i*14,9.4,8.6,0.9);
        }
      });
      rightFace(105,69,z+15, () => {
        for (let i=0;i<18;i++) {
          ctx.fillStyle="#21271f";ctx.fillRect(14+i*5,3.6,2.4,7.9);
          ctx.fillStyle="#5d6357";ctx.fillRect(16+i*5,3.6,.6,7.9);
        }
      });
      onTop(z+15, () => {
        shape(beveled(-92,-55,184,110,4),"#343b33","#898d7d",0.8);
        for(let i=0;i<8;i++) line([[47+i*4,-47],[47+i*4,36]],"#697061",0.55);
        topBolts(96,60,true);
      });
      const fins = { top:"#a4a799", front:"#62685c", side:"#41483d", bevel:"#787e70", edge:"#4e554a" };
      for (const x of [-77,-20,37]) {
        slab(beveled(x,-41,45,82,2.6),z+15,2.3,darkMetal);
        for(let y=-37;y<38;y+=5.6) {
          slab(beveled(x+2,y,41,1.8,0.7),z+17.3,6.6,fins);
        }
      }
    }

    function session(z) {
      slab(inner,z-3.5,4,darkMetal);
      const housing = {
        top:gradient(133,60,363,232,[[0,"#ff8a51"],[0.3,"#fa6e39"],[0.69,"#ef542b"],[1,"#e84d26"]]),
        front:"#d84420",side:"#a2331b",bevel:"#b83c21",edge:"#8c321e"
      };
      slab(body,z,14,housing);
      frontFace(69,z+14,() => {
        line([[-96,1.1],[97,1.1]],"#ff9564",0.85);
        line([[-95,12.2],[96,12.2]],"#a9361d",0.6);
        for(let i=0;i<13;i++) {
          ctx.fillStyle="#7f301e";ctx.fillRect(-86+i*4.1,4,1.6,5.7);
        }
        ctx.fillStyle="#80311f";ctx.fillRect(39,4,31,3.4);
        ctx.fillStyle="#f1cc9b";ctx.fillRect(40,4.5,21,1.8);
        for(const x of [81,87,93]) dot(x,5.4,1.35,"#612c1c");
      });
      rightFace(105,69,z+14,() => {
        for(let i=0;i<16;i++) {
          ctx.fillStyle="#712c1c";ctx.fillRect(13+i*5.8,3.7,2.2,6.8);
          ctx.fillStyle="#d85830";ctx.fillRect(15.1+i*5.8,3.7,0.7,6.8);
        }
      });
      onTop(z+14.1,() => {
        shape(beveled(-101,-64.8,202,129.6,6),null,"#ff9c6e",0.75);
        shape(beveled(-90,-52,180,104,5),null,"#b94425",0.8);
        shape(beveled(-88.8,-50.9,177.5,101.7,4.5),null,"#ff9261",0.75);
        // Recessed console window with a beveled perimeter and antiglare glass.
        shape(beveled(-76,-36,98,63,5),"#a23d26","#f98a57",1);
        shape(beveled(-73.7,-33.5,93.6,57.8,3.3),"#32372f","#703120",1.15);
        shape(beveled(-70.3,-30.5,87,51.7,2.3),
          gradient(-67,-29,12,24,[[0,"#41473e"],[0.5,"#2c332c"],[1,"#262c26"]]),"#797d68",0.65);
        ctx.save();
        outline(beveled(-69,-30,85,51,2.3));
        ctx.clip();
        for (let y=-29;y<22;y+=2.3) line([[-71,y],[20,y]],"rgba(203,215,183,.038)",0.6);
        ctx.restore();
        line([[-56,-17],[-43,-6],[-56,5]],"#ededdc",4);
        line([[-41,6],[-27,6]],"#f48352",3.5);
        for(let i=0;i<3;i++) {
          ctx.fillStyle=i === 0 ? "#abab95" : "#696f60";
          ctx.fillRect(-12,-14 + i*7, i === 1 ? 16 : 21,1.7);
        }
        for(let i=0;i<7;i++) {
          const x=34+i*6.4;
          shape(beveled(x,-32,2.4,56,1.1),"#9b3922",null);
          line([[x+2.7,-30],[x+2.7,22]],"#ff9c6b",0.8);
        }
        ctx.fillStyle="#783520";
        for (let i=0;i<4;i++) ctx.fillRect(-72+i*5.2,37,2.5,2.1);
        line([[-43,38],[65,38]],"rgba(140,54,29,.55)",0.75);
        topBolts(95,58,true);
      });
    }

    function leader(anchor, y, label) {
      const x = 428, elbow = 414;
      const [ax,ay] = anchor;
      line([[ax,ay],[ax+8,ay],[elbow,y],[x-5,y]],"#85877b",0.85);
      dot(ax,ay,2.25,pale,"#74796a",0.85);
      ctx.fillStyle="#464c40";
      ctx.font = (narrow ? "bold 12.5px " : "11.5px ") + "Menlo, monospace";
      ctx.textAlign="left";
      ctx.textBaseline="middle";
      ctx.fillText(label,x,y);
    }

    function redraw() {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      narrow = rect.width < 430;
      ctx.setTransform(1,0,0,1,0,0);
      ctx.clearRect(0,0,width,height);
      const scale = Math.min(width/W, height/H);
      ctx.setTransform(scale,0,0,scale,(width-W*scale)/2,(height-H*scale)/2);
      ctx.lineJoin = "round"; ctx.lineCap = "round";
      originY = 255 - (1-openness)*27;
      const middleZ = 27 + 50 * openness;
      const topZ = 52 + 94 * openness;

      softShadow(244,originY+40,164,44,0.2);
      softShadow(254,originY+32,121,27,0.15);
      base();
      if(openness > 0.025) {
        ctx.save();
        ctx.setLineDash([2.7,4.8]);
        for(const [x,y] of [[-95,-58],[95,-58],[-95,58],[95,58]]) {
          line([point(x,y,21),point(x,y,middleZ-3)],"rgba(101,103,88," + openness*0.55 + ")",0.85);
        }
        ctx.restore();
      }
      services(middleZ);
      if(openness > 0.025) {
        ctx.save();
        ctx.setLineDash([2.7,4.8]);
        for(const [x,y] of [[-95,-58],[95,-58],[-95,58],[95,58]]) {
          line([point(x,y,middleZ+18),point(x,y,topZ-4)],"rgba(101,103,88," + openness*0.55 + ")",0.85);
        }
        ctx.restore();
      }
      session(topZ);
      leader(point(101,-24,topZ+8), 64 + (1-openness)*46, "Agent session");
      leader(point(106,-24,middleZ+7), 171 + (1-openness)*2, "Services");
      leader(point(109,-22,14), 281 - (1-openness)*61, "Git worktree");
    }

    canvas.addEventListener("werk-view",event => {
      if (typeof event.detail?.exploded !== "boolean") return;
      destination = event.detail.exploded ? 1 : 0;
      cancelAnimationFrame(frame);
      const start = openness, startedAt = performance.now();
      if (motionPreference.matches) { openness = destination; redraw(); return; }
      function animate(now) {
        const t = Math.min(1,(now-startedAt)/640);
        const ease = t*t*(3-2*t);
        openness = start+(destination-start)*ease;
        redraw();
        if(t < 1) frame = requestAnimationFrame(animate);
      }
      frame = requestAnimationFrame(animate);
    });
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(redraw).observe(canvas);
    else window.addEventListener("resize",redraw);
    redraw();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded",mount,{once:true});
  else mount();
})();
