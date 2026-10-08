"""Synthetic regression: diagnostic capture must not change filter outcomes."""
import importlib.util
from pathlib import Path
import unittest
import numpy as np

spec=importlib.util.spec_from_file_location('sam_runner',Path(__file__).resolve().parents[1]/'scripts/sam-runner.py')
runner=importlib.util.module_from_spec(spec);spec.loader.exec_module(runner)

class PipelineDiagnostics(unittest.TestCase):
    def supported_record(self, mask, confidence=.7, quality=.95, box=None):
        ys,xs=np.where(mask)
        return {'segmentation':mask,'area':int(mask.sum()),'predicted_iou':quality,
                'detectorConfidence':confidence,
                'detectorBox':box or [int(xs.min()),int(ys.min()),int(xs.max()+1),int(ys.max()+1)]}

    def test_small_detector_supported_piece_survives(self):
        image=np.full((200,200,3),128,np.uint8)
        mask=np.zeros((200,200),bool);mask[100:105,100:105]=True
        traces=[]
        kept,_=runner.select_objects([self.supported_record(mask)],image,traces)
        self.assertEqual(len(kept),1)
        self.assertTrue(traces[0]['detectorSupported'])
        for record in [self.supported_record(mask,confidence=.1),self.supported_record(mask,quality=.7),
                       self.supported_record(mask,box=[20,20,30,30])]:
            kept,counts=runner.select_objects([record],image)
            self.assertEqual(len(kept),0);self.assertEqual(counts['background'],1)

    def test_texture_is_warning_with_detector_support_not_veto(self):
        rng=np.random.default_rng(4)
        image=rng.integers(30,220,(200,200,3),dtype=np.uint8)
        # Textured wheel-like region; surrounding carpet can be equally textured.
        yy,xx=np.indices((200,200));mask=(xx-100)**2+(yy-100)**2<35**2
        record=self.supported_record(mask)
        traces=[];kept,_=runner.select_objects([record,record.copy()],image,traces)
        self.assertEqual(len(kept),1)
        self.assertTrue(traces[0]['warnings'])
        self.assertEqual(traces[1]['reason'],'duplicate/nested')
        del record['detectorConfidence']
        kept,counts=runner.select_objects([record],image)
        self.assertEqual(len(kept),0);self.assertEqual(counts['texture'],1)

    def test_detector_support_does_not_bypass_background_checks(self):
        image=np.full((200,200,3),128,np.uint8)
        for bounds in [(0,20,40,60),(10,10,190,190)]:
            x0,y0,x1,y1=bounds
            mask=np.zeros((200,200),bool);mask[y0:y1,x0:x1]=True
            kept,counts=runner.select_objects([self.supported_record(mask)],image)
            self.assertEqual(len(kept),0);self.assertEqual(counts['background'],1)

    def test_capture_keeps_filter_outcomes_and_source_ids(self):
        image=np.full((200,200,3),128,np.uint8)
        large=np.zeros((200,200),bool);large[30:70,30:70]=True
        small=np.zeros((200,200),bool);small[100:105,100:105]=True
        records=[{'segmentation':small,'area':25,'predicted_iou':.95},{'segmentation':large,'area':1600,'predicted_iou':.98},{'segmentation':large.copy(),'area':1600,'predicted_iou':.98}]
        baseline,rejected=runner.select_objects(records,image)
        traces=[];actual,counts=runner.select_objects(records,image,traces)
        self.assertEqual(rejected,counts);self.assertEqual(len(baseline),len(actual))
        self.assertTrue(np.array_equal(baseline[0]['mask'],actual[0]['mask']))
        by_id={p['id']:p for p in traces}
        self.assertEqual(by_id[1]['reason'],'size');self.assertEqual(by_id[2]['decision'],'retained');self.assertEqual(by_id[3]['reason'],'duplicate/nested')
        self.assertEqual(actual[0]['proposalId'],2)
        self.assertEqual(by_id[1]['raw']['area'],25)
        self.assertEqual(by_id[1]['cleaned']['area'],25)

if __name__=='__main__':unittest.main()
