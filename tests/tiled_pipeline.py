"""Synthetic source-tile, duplicate, seam and coordinate tests; no weights."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
import importlib.util
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts'))
from yolo_detector import tile_boxes, merge_detections, detect_bricks_tiled
from tiled_pipeline import project_mask, project_feature, run_overlap, segment_tiled
spec=importlib.util.spec_from_file_location('sam_runner',Path(__file__).resolve().parents[1]/'scripts/sam-runner.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

class SourceTiles(unittest.TestCase):
    def test_tiles_cover_source_and_overlap(self):
        boxes=tile_boxes(4284,5712)
        self.assertEqual(len(boxes),20)
        covered=np.zeros((5712,4284),bool)
        for x,y,x1,y1 in boxes:
            self.assertLessEqual(x1-x,1536);self.assertLessEqual(y1-y,1536)
            covered[y:y1,x:x1]=True
        self.assertTrue(covered.all())
        self.assertEqual(tile_boxes(800,600),[(0,0,800,600)])

    def test_nms_merges_duplicates_not_nested_pins(self):
        records=[{'box':[10,10,100,100],'confidence':.8},
                 {'box':[11,11,101,101],'confidence':.6},
                 {'box':[40,40,50,50],'confidence':.9}]
        self.assertEqual(len(merge_detections(records)),2)

    def test_tile_offsets_progress_and_internal_seams(self):
        calls=[];progress=[]
        def detect(rgb,detailed=False):
            calls.append(rgb.shape)
            if len(calls)==1:return [{'box':[500,100,600,200],'confidence':.9}]
            # A complete object, plus a clipped box at the internal crop edge.
            return [{'box':[500,100,600,200],'confidence':.8},
                    {'box':[0,400,50,450],'confidence':.7}]
        detections,stats=detect_bricks_tiled(np.zeros((1000,2500,3),np.uint8),detector=detect,on_progress=progress.append)
        self.assertEqual(stats['tiles'],2)
        self.assertEqual(len(calls),3)
        self.assertTrue(any(d['box']==[1464,100,1564,200] for d in detections))
        self.assertFalse(any(d['box']==[964,400,1014,450] for d in detections))
        self.assertEqual(progress[-1]['completed'],2)

    def test_projected_mask_holes_feature_coordinates_and_run_overlap(self):
        local=np.ones((40,40),bool);local[10:30,10:30]=False
        result=project_mask(local,(100,200,140,240),(400,400),(200,200))
        self.assertTrue(result[101,51]);self.assertFalse(result[110,60])
        self.assertEqual(int(result.sum()),300)
        feature=project_feature({'x':10,'y':20,'radius':4,'box':[8,18,4,4]},(100,200),(.5,.5))
        self.assertEqual(feature['x'],55);self.assertEqual(feature['y'],110)
        self.assertEqual(feature['box'],[54,109,2,2])
        self.assertEqual(run_overlap([5,10,20,3],[10,10,21,5]),7)

    def test_local_sam_crops_masks_diagnostics_and_duplicate_removal(self):
        class Predictor:
            shapes=[]
            def __init__(self,model):pass
            def set_image(self,image):self.shape=image.shape[:2];self.shapes.append(self.shape)
            def predict(self,box,multimask_output=False):
                mask=np.zeros(self.shape,bool);x,y,x1,y1=np.rint(box).astype(int)
                mask[y:y1,x:x1]=True
                return [mask],[.98],None
        detections=[{'box':[200,200,280,280],'confidence':.8,'source':'tile'},
                    {'box':[200,200,280,280],'confidence':.7,'source':'whole-image'},
                    {'box':[500,500,510,520],'confidence':.8,'source':'tile'}]
        def features(rgb,box,mask):
            ys,xs=np.where(mask)
            return [{'x':float(xs.mean()),'y':float(ys.mean()),'radius':2,'confidence':.8}]
        with patch.dict(sys.modules,{'mobile_sam':SimpleNamespace(SamPredictor=Predictor)}), \
             patch('yolo_detector.detect_bricks_tiled',return_value=(detections,{'tiles':4})), \
             patch('yolo_detector.detect_studs',side_effect=features), \
             patch('tube_detector.detect_tubes',return_value=[]):
            result=segment_tiled(np.full((800,800,3),128,np.uint8),np.full((200,200,3),128,np.uint8),None,lambda p:None,runner.select_objects,runner.mask_record)
        self.assertEqual(len(result['components']),2)
        self.assertEqual(result['rejected']['nested'],1)
        self.assertEqual(result['diagnostics']['width'],200)
        self.assertTrue(all(max(shape)<800 for shape in Predictor.shapes))
        pin=min(result['components'],key=lambda c:c['area'])
        self.assertGreater(pin['area'],0)
        self.assertAlmostEqual(pin['studDetections'][0]['x'],126.125)
        self.assertEqual(result['diagnostics']['proposals'][1]['reason'],'duplicate/nested')
        self.assertLess(max(pin['runs']),40000)

if __name__=='__main__':unittest.main()
